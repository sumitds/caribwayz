const db = require('../config/db');
const ws = require('../services/wsService');
const firebase = require('../config/firebase');
const { buildNotificationService } = require('../services/notificationService');
const { success, error, notFound, forbidden } = require('../utils/response');
const { displayName } = require('../utils/displayName');
const { blockedWithSubquery, notBlockedBetween, idList } = require('../services/blockService');

/**
 * Group events that other members must see: SOS, check-in, deletion, and a
 * member's status on a group drive (arrived, stopped, running late, left).
 *
 * The WebSocket server never relays client messages, so the REST handler that
 * accepts an event is the only place it can be delivered from. Each handler
 * validates, authorises against the database, then broadcasts to the group's
 * room and, where a member may be offline, sends a notification (a row in
 * their list, and a push to their phone when they allow group/emergency push).
 *
 * An SOS, check-in or status never reaches a member in a block with the
 * sender, live or as a notification (services/blockService.js).
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ISO-8601 date-time with an explicit offset. A value without one is treated as
 * unusable rather than guessed at: the server would read it in its own zone,
 * which is not the phone's, and stamp the event at the wrong instant.
 */
const ISO_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

const NOTE_MAX_LENGTH = 500;

/** notifications.title is VARCHAR(255). */
const TITLE_MAX_LENGTH = 255;

const NOT_A_MEMBER = 'Not a member of this group';

/**
 * What a member's own app reports about them on a group drive. The app works
 * each one out from its position (mobile group_status_detector.dart); `left`
 * is also sent by the API itself when the member leaves the group.
 */
const GROUP_STATUSES = Object.freeze(['arrived', 'stopped', 'delayed', 'left']);

/**
 * A member's status is shared with the group at most once per this window, for
 * each status. A phone whose GPS keeps crossing a threshold (stopped, moving,
 * stopped again in traffic) would otherwise ring every phone in the group each
 * time. Leaving the group is held to the same window (see announceLeftGroup).
 */
const STATUS_REPEAT_WINDOW_SECONDS = 15 * 60;

/**
 * The group_status_reports row (migration 029) that holds when a member's
 * leaving the group was last announced, apart from 'left', which is ending
 * the drive.
 */
const LEFT_GROUP_CLAIM = 'left_group';

/** The longest delay a report may carry: a day. */
const MAX_DELAY_MINUTES = 24 * 60;

/**
 * "12 min", "1 hr", "2 hr 5 min": the form the app shows an ETA in
 * (GroupEtaCalculator.formatEta).
 */
const formatMinutes = (minutes) => {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
};

/**
 * Reads delay_minutes: a whole number of minutes from 1 to MAX_DELAY_MINUTES.
 * Returns { error } or { minutes }. Numeric strings are accepted; a fraction
 * is rounded.
 */
const readDelayMinutes = (value) => {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  else return { error: 'delay_minutes is required for a delayed status' };
  const minutes = Math.round(n);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_DELAY_MINUTES) {
    return { error: `delay_minutes must be a number from 1 to ${MAX_DELAY_MINUTES}` };
  }
  return { minutes };
};

/**
 * The notification copy for a status. [reason] tells the two kinds of `left`
 * apart: 'left_group' (they left the group) or 'ended_drive' (they ended their
 * group drive and are still in the group). Like the SOS and check-in, the copy
 * never says where the member is.
 */
const statusCopy = ({ status, reason, senderName, groupName, delayMinutes }) => {
  switch (status) {
    case 'arrived':
      return {
        title: `${senderName} arrived`,
        message: `${senderName} arrived at the destination of your group "${groupName}".`,
      };
    case 'stopped':
      return {
        title: `${senderName} has stopped`,
        message: `${senderName} has stopped on the way, in your group "${groupName}".`,
      };
    case 'delayed':
      return {
        title: `${senderName} is running late (about ${formatMinutes(delayMinutes)})`,
        message: `${senderName} is running about ${formatMinutes(delayMinutes)} behind their first arrival estimate, in your group "${groupName}".`,
      };
    default:
      return reason === 'left_group'
        ? {
            title: `${senderName} left the group`,
            message: `${senderName} left your group "${groupName}".`,
          }
        : {
            title: `${senderName} left the group drive`,
            message: `${senderName} ended their group drive, in your group "${groupName}". They are still in the group.`,
          };
  }
};

/** Truncates by code point so a surrogate pair is never split in half. */
const truncate = (text, max) => {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
};

/**
 * Parses one coordinate. Returns undefined when absent, null when present but
 * invalid, or the number. Numeric strings are accepted; anything else is not.
 */
const parseCoordinate = (value, limit) => {
  if (value === undefined || value === null) return undefined;
  let n;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    n = Number(value);
  } else {
    return null;
  }
  if (!Number.isFinite(n) || Math.abs(n) > limit) return null;
  return n;
};

/**
 * Reads latitude/longitude from a request body.
 * Returns { error } or { latitude, longitude } (both undefined when absent and
 * not required).
 */
const readCoordinates = (body, required) => {
  const latitude = parseCoordinate(body.latitude, 90);
  const longitude = parseCoordinate(body.longitude, 180);

  if (latitude === null) return { error: 'latitude must be a number between -90 and 90' };
  if (longitude === null) return { error: 'longitude must be a number between -180 and 180' };

  if (latitude === undefined && longitude === undefined) {
    if (required) return { error: 'latitude and longitude are required' };
    return { latitude: undefined, longitude: undefined };
  }
  if (latitude === undefined || longitude === undefined) {
    return { error: 'latitude and longitude must be sent together' };
  }
  return { latitude, longitude };
};

/** Returns { error } or { note } where note is a trimmed, capped string or undefined. */
const readNote = (value) => {
  if (value === undefined || value === null) return { note: undefined };
  if (typeof value !== 'string') return { error: 'note must be text' };
  const trimmed = value.trim();
  if (trimmed === '') return { note: undefined };
  return { note: truncate(trimmed, NOTE_MAX_LENGTH) };
};

/**
 * The client's timestamp normalised to ISO-8601 UTC, or the server receive time
 * when the client value is missing or unparseable.
 */
const toIsoTimestamp = (value, receivedAt) => {
  if (typeof value === 'string' && ISO_DATETIME_PATTERN.test(value.trim())) {
    const ms = Date.parse(value.trim());
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return receivedAt.toISOString();
};

const sameId = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * Builds the handlers against injected collaborators so they can be exercised
 * without a database or live sockets.
 *
 * @param {object} deps
 * @param {(text: string, params: any[]) => Promise<{rows: any[], rowCount: number}>} deps.query
 * @param {(groupId: string, payload: object) => number} deps.broadcastToGroup
 * @param {(groupId: string, userId: string) => boolean} deps.isMemberConnected
 * @param {() => Date} [deps.now]
 * @param {(userIds: string[], payload: object) => Promise<number>} [deps.notify]
 *   notificationService.notify; by default built on [deps.query]
 */
const buildGroupEventHandlers = ({
  query,
  broadcastToGroup,
  isMemberConnected,
  now = () => new Date(),
  notify = buildNotificationService({ query, getMessaging: firebase.getMessaging }).notify,
}) => {
  /**
   * The caller's active membership, with the names the frames and notification
   * copy need. The JWT carries only { id, email, role }, so req.user.name is
   * not available and the sender's name is read here. blocked_with lists the
   * people in a block with the caller.
   */
  const loadMembership = async (groupId, userId) => {
    const result = await query(
      `SELECT g.group_name, u.name AS user_name, ARRAY${blockedWithSubquery('$2')} AS blocked_with,
              (g.destination_lat IS NOT NULL AND g.destination_lng IS NOT NULL) AS has_destination
         FROM group_members gm
         JOIN groups g ON g.id = gm.group_id
         JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = $1 AND gm.user_id = $2 AND gm.status = 'active'`,
      [groupId, userId]
    );
    const row = result.rows[0];
    // Notification rows outlive the frame, so the stored copy must never read
    // "SOS from default" or "SOS from " for an account without a real name.
    return row
      ? { ...row, user_name: displayName(row.user_name), blocked_with: idList(row.blocked_with) }
      : null;
  };

  /**
   * Broadcasts and returns how many OTHER members were reached live; the
   * sender's own socket receives the frame too and is not counted.
   */
  const broadcastToOthers = (groupId, senderId, frame, excludeUserIds = []) => {
    const senderOnline = isMemberConnected(groupId, senderId);
    const sent = broadcastToGroup(groupId, frame, excludeUserIds);
    return Math.max(0, sent - (senderOnline ? 1 : 0));
  };

  /**
   * Active members other than [userId]. With [skipBlocked], members in a block
   * with [userId] are left out too. Never throws; null when the read failed.
   */
  const loadOtherActiveMemberIds = async (groupId, userId, { skipBlocked = false } = {}) => {
    try {
      const result = await query(
        `SELECT user_id FROM group_members
          WHERE group_id = $1 AND status = 'active' AND user_id <> $2${
            skipBlocked ? `
            AND ${notBlockedBetween('$2', 'user_id')}` : ''}`,
        [groupId, userId]
      );
      return result.rows.map((row) => row.user_id);
    } catch (err) {
      console.error(`Loading members to notify in group ${groupId} failed:`, err.message);
      return null;
    }
  };

  /**
   * Notifies [recipientIds] (null when they could not be read). [what] names
   * the event in the log, with the group id, when delivery fails.
   *
   * Never throws. Returns the number notified, or -1 when it failed.
   */
  const notifyMembers = async (groupId, recipientIds, what, payload) => {
    if (recipientIds === null) return -1;
    if (recipientIds.length === 0) return 0;
    const notified = await notify(recipientIds, payload);
    if (notified < 0) console.error(`${what} notification failed for group ${groupId}`);
    return notified;
  };

  /**
   * Sends an SOS notification to every other active member.
   *
   * Like notifyResponders, it carries no coordinates and no note: rows are
   * readable with only `authenticate`, persist after the member leaves the
   * group, and are pageable as an archive. The live frame carries the location;
   * the notification only says who raised it and in which group.
   */
  const notifySosToMembers = async (groupId, senderId, senderName, groupName) =>
    notifyMembers(groupId, await loadOtherActiveMemberIds(groupId, senderId, { skipBlocked: true }), 'Group SOS', {
      type: 'emergency',
      category: 'emergency',
      title: truncate(`SOS from ${senderName}`, TITLE_MAX_LENGTH),
      message: `${senderName} raised an SOS in your group "${groupName}". Open the group to see where they are.`,
      reference_id: groupId,
    });

  /**
   * Saves a check-in for members who do not have the app open, so "I'm safe"
   * still reaches them later. Like the SOS, it carries no coordinates.
   */
  const notifyCheckInToMembers = async (groupId, senderId, senderName, groupName) =>
    notifyMembers(groupId, await loadOtherActiveMemberIds(groupId, senderId, { skipBlocked: true }), 'Group check-in', {
      type: 'group',
      category: 'group',
      title: truncate(`${senderName} checked in`, TITLE_MAX_LENGTH),
      message: `${senderName} checked in and is safe, in your group "${groupName}".`,
      reference_id: groupId,
    });

  /**
   * Tells former members the group is gone. Runs after the delete, when the
   * group_members rows have already cascaded away, so recipients are passed in.
   */
  const notifyGroupDeleted = async (groupId, groupName, recipientIds) =>
    notifyMembers(groupId, recipientIds, 'Group deletion', {
      type: 'group',
      category: 'group',
      title: 'Group deleted',
      message: `${groupName} was deleted by its creator`,
      reference_id: groupId,
    });

  /**
   * Records that [userId] shared [status] in [groupId] now, unless they did so
   * within STATUS_REPEAT_WINDOW_SECONDS. True when this report may go out.
   * One statement, so two requests racing cannot both pass. Throws on a
   * database error.
   */
  const claimStatus = async (groupId, userId, status) => {
    const result = await query(
      `INSERT INTO group_status_reports (group_id, user_id, status, reported_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (group_id, user_id, status) DO UPDATE SET reported_at = EXCLUDED.reported_at
        WHERE group_status_reports.reported_at <= EXCLUDED.reported_at - make_interval(secs => $4)
       RETURNING reported_at`,
      [groupId, userId, status, STATUS_REPEAT_WINDOW_SECONDS]
    );
    return result.rowCount > 0;
  };

  /**
   * Tells the group a member's status: the live frame to everyone not in a
   * block with them, and a notification for the other active members, which
   * reaches a phone with the app closed as a push when they allow group push.
   * Returns { delivered_live, notified }.
   */
  const shareStatus = async ({ groupId, senderId, senderName, groupName, blockedWith, status, reason, delayMinutes, at }) => {
    const frame = {
      type: 'group_status',
      user_id: senderId,
      user_name: senderName,
      status,
      at,
    };
    if (status === 'delayed') frame.delay_minutes = delayMinutes;
    if (status === 'left') frame.reason = reason;

    const deliveredLive = broadcastToOthers(groupId, senderId, frame, blockedWith);

    const { title, message } = statusCopy({ status, reason, senderName, groupName, delayMinutes });
    const data = { kind: 'group_status', status, member_id: senderId };
    if (status === 'delayed') data.delay_minutes = String(delayMinutes);
    if (status === 'left') data.reason = reason;

    const notified = await notifyMembers(
      groupId,
      await loadOtherActiveMemberIds(groupId, senderId, { skipBlocked: true }),
      `Group status "${status}"`,
      {
        type: 'group',
        category: 'group',
        title: truncate(title, TITLE_MAX_LENGTH),
        message,
        reference_id: groupId,
        data,
      }
    );
    return { delivered_live: deliveredLive, notified };
  };

  /**
   * Tells the rest of the group that [userId] left it. Called once the leave
   * is saved, so the names are read without the membership.
   *
   * Held to STATUS_REPEAT_WINDOW_SECONDS like any status, under its own row
   * ('left_group'), so leaving, rejoining by code and leaving again does not
   * ring the group each time, and ending the drive first ('left') does not
   * hide the leave.
   *
   * Never throws: the leave has happened whatever becomes of the announcement.
   * Returns { delivered_live, notified, repeated }, or null when it could not
   * be sent.
   */
  const announceLeftGroup = async (groupId, userId) => {
    try {
      if (!(await claimStatus(groupId, userId, LEFT_GROUP_CLAIM))) {
        return { delivered_live: 0, notified: 0, repeated: true };
      }
      const result = await query(
        `SELECT g.group_name, u.name AS user_name, ARRAY${blockedWithSubquery('$2')} AS blocked_with
           FROM groups g
           JOIN users u ON u.id = $2
          WHERE g.id = $1`,
        [groupId, userId]
      );
      const row = result.rows[0];
      if (!row) return null;
      const shared = await shareStatus({
        groupId,
        senderId: userId,
        senderName: displayName(row.user_name),
        groupName: row.group_name,
        blockedWith: idList(row.blocked_with),
        status: 'left',
        reason: 'left_group',
        at: now().toISOString(),
      });
      return { ...shared, repeated: false };
    } catch (err) {
      console.error(`Announcing that user ${userId} left group ${groupId} failed:`, err.message);
      return null;
    }
  };

  const sendSos = async (req, res) => {
    const { id } = req.params;
    try {
      const receivedAt = now();
      const body = req.body || {};

      if (!UUID_PATTERN.test(String(id))) return error(res, 'Group id must be a valid UUID', 400);

      const coords = readCoordinates(body, true);
      if (coords.error) return error(res, coords.error, 400);

      const { note, error: noteError } = readNote(body.note);
      if (noteError) return error(res, noteError, 400);

      const member = await loadMembership(id, req.user.id);
      if (!member) return forbidden(res, NOT_A_MEMBER);

      const frame = {
        type: 'sos',
        user_id: req.user.id,
        user_name: member.user_name,
        latitude: coords.latitude,
        longitude: coords.longitude,
        raised_at: toIsoTimestamp(body.raised_at, receivedAt),
      };
      if (note !== undefined) frame.note = note;

      const deliveredLive = broadcastToOthers(id, req.user.id, frame, member.blocked_with);
      const notified = await notifySosToMembers(id, req.user.id, member.user_name, member.group_name);

      return success(res, { delivered_live: deliveredLive, notified }, 'SOS sent to the group');
    } catch (err) {
      console.error(`Group SOS error (group ${id}, user ${req.user && req.user.id}):`, err);
      return error(res, 'Failed to send SOS', 500);
    }
  };

  const checkIn = async (req, res) => {
    const { id } = req.params;
    try {
      const receivedAt = now();
      const body = req.body || {};

      if (!UUID_PATTERN.test(String(id))) return error(res, 'Group id must be a valid UUID', 400);

      if (typeof body.checked_in !== 'boolean') {
        return error(res, 'checked_in must be true or false', 400);
      }

      const coords = readCoordinates(body, false);
      if (coords.error) return error(res, coords.error, 400);

      const member = await loadMembership(id, req.user.id);
      if (!member) return forbidden(res, NOT_A_MEMBER);

      const frame = {
        type: 'check_in',
        user_id: req.user.id,
        user_name: member.user_name,
        checked_in: body.checked_in,
      };
      if (coords.latitude !== undefined) {
        frame.latitude = coords.latitude;
        frame.longitude = coords.longitude;
      }
      frame.at = toIsoTimestamp(body.at, receivedAt);

      const deliveredLive = broadcastToOthers(id, req.user.id, frame, member.blocked_with);
      // Only a check-in is saved for later; a cancellation is live-only.
      const notified = body.checked_in
        ? await notifyCheckInToMembers(id, req.user.id, member.user_name, member.group_name)
        : 0;

      return success(
        res,
        { delivered_live: deliveredLive, notified },
        body.checked_in ? 'Checked in' : 'Check-in cancelled'
      );
    } catch (err) {
      console.error(`Group check-in error (group ${id}, user ${req.user && req.user.id}):`, err);
      return error(res, 'Failed to check in', 500);
    }
  };

  const deleteGroup = async (req, res) => {
    const { id } = req.params;
    try {
      if (!UUID_PATTERN.test(String(id))) return error(res, 'Group id must be a valid UUID', 400);

      const groupResult = await query(
        'SELECT id, group_name, created_by FROM groups WHERE id = $1',
        [id]
      );
      if (groupResult.rows.length === 0) return notFound(res, 'Group not found');

      const group = groupResult.rows[0];
      if (!sameId(group.created_by, req.user.id)) {
        return forbidden(res, 'Only the group creator can delete this group');
      }

      // Read before the delete: group_members rows cascade away with the group.
      const recipients = await loadOtherActiveMemberIds(id, req.user.id);

      // created_by is re-checked so a concurrent ownership change cannot slip
      // between the read above and this statement.
      const deleted = await query(
        'DELETE FROM groups WHERE id = $1 AND created_by = $2',
        [id, req.user.id]
      );
      if (deleted.rowCount === 0) return notFound(res, 'Group not found');

      // Broadcast only once the row is gone, so no client drops a group whose
      // delete then failed. The in-memory room outlives the row.
      // deleted_by lets the creator's own app ignore the echo of its action.
      const deliveredLive = broadcastToOthers(id, req.user.id, {
        type: 'group_deleted',
        group_id: id,
        deleted_by: req.user.id,
      });

      const notified = await notifyGroupDeleted(id, group.group_name, recipients);

      return success(res, { delivered_live: deliveredLive, notified }, 'Group deleted');
    } catch (err) {
      console.error(`Delete group error (group ${id}, user ${req.user && req.user.id}):`, err);
      return error(res, 'Failed to delete group', 500);
    }
  };

  const reportStatus = async (req, res) => {
    const { id } = req.params;
    try {
      const receivedAt = now();
      const body = req.body || {};

      if (!UUID_PATTERN.test(String(id))) return error(res, 'Group id must be a valid UUID', 400);

      const status = typeof body.status === 'string' ? body.status.trim().toLowerCase() : '';
      if (!GROUP_STATUSES.includes(status)) {
        return error(res, `status must be one of ${GROUP_STATUSES.join(', ')}`, 400);
      }

      let delayMinutes;
      if (status === 'delayed') {
        const delay = readDelayMinutes(body.delay_minutes);
        if (delay.error) return error(res, delay.error, 400);
        delayMinutes = delay.minutes;
      }

      const member = await loadMembership(id, req.user.id);
      if (!member) return forbidden(res, NOT_A_MEMBER);

      // Arriving and running late are measured against the group's
      // destination; a group without one has nothing to arrive at.
      if ((status === 'arrived' || status === 'delayed') && !member.has_destination) {
        return error(res, 'This group has no destination, so arrival and delays are not shared', 409);
      }

      if (!(await claimStatus(id, req.user.id, status))) {
        return success(
          res,
          { delivered_live: 0, notified: 0, repeated: true },
          'Already shared with the group recently'
        );
      }

      const shared = await shareStatus({
        groupId: id,
        senderId: req.user.id,
        senderName: member.user_name,
        groupName: member.group_name,
        blockedWith: member.blocked_with,
        status,
        reason: 'ended_drive',
        delayMinutes,
        at: toIsoTimestamp(body.at, receivedAt),
      });

      return success(res, { ...shared, repeated: false }, 'Status shared with the group');
    } catch (err) {
      console.error(`Group status error (group ${id}, user ${req.user && req.user.id}):`, err);
      return error(res, 'Failed to share your status', 500);
    }
  };

  return { sendSos, checkIn, deleteGroup, reportStatus, announceLeftGroup };
};

const { sendSos, checkIn, deleteGroup, reportStatus, announceLeftGroup } = buildGroupEventHandlers({
  query: db.query,
  broadcastToGroup: ws.broadcastToGroup,
  isMemberConnected: ws.isMemberConnected,
});

module.exports = {
  buildGroupEventHandlers,
  sendSos,
  checkIn,
  deleteGroup,
  reportStatus,
  announceLeftGroup,
  NOTE_MAX_LENGTH,
  GROUP_STATUSES,
  STATUS_REPEAT_WINDOW_SECONDS,
  MAX_DELAY_MINUTES,
};
