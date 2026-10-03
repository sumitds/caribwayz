const db = require('../config/db');
const ws = require('../services/wsService');
const { success, error, notFound, forbidden } = require('../utils/response');

/**
 * Group events that other members must see: SOS, check-in and deletion.
 *
 * The WebSocket server never relays client messages, so the REST handler that
 * accepts an event is the only place it can be delivered from. Each handler
 * validates, authorises against the database, then broadcasts to the group's
 * room and, where a member may be offline, writes a notification row.
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
 */
const buildGroupEventHandlers = ({ query, broadcastToGroup, isMemberConnected, now = () => new Date() }) => {
  /**
   * The caller's active membership, with the names the frames and notification
   * copy need. The JWT carries only { id, email, role }, so req.user.name is
   * not available and the sender's name is read here.
   */
  const loadMembership = async (groupId, userId) => {
    const result = await query(
      `SELECT g.group_name, u.name AS user_name
         FROM group_members gm
         JOIN groups g ON g.id = gm.group_id
         JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = $1 AND gm.user_id = $2 AND gm.status = 'active'`,
      [groupId, userId]
    );
    return result.rows[0] || null;
  };

  /**
   * Broadcasts and returns how many OTHER members were reached live; the
   * sender's own socket receives the frame too and is not counted.
   */
  const broadcastToOthers = (groupId, senderId, frame) => {
    const senderOnline = isMemberConnected(groupId, senderId);
    const sent = broadcastToGroup(groupId, frame);
    return Math.max(0, sent - (senderOnline ? 1 : 0));
  };

  /**
   * Writes an SOS notification to every other active member.
   *
   * Like notifyResponders, the row carries no coordinates and no note: rows are
   * readable with only `authenticate`, persist after the member leaves the
   * group, and are pageable as an archive. The live frame carries the location;
   * the row only says who raised it and in which group.
   *
   * Never throws. Returns the number notified, or -1 when the insert failed.
   */
  const notifySosToMembers = async (groupId, senderId, senderName, groupName) => {
    try {
      const result = await query(
        `INSERT INTO notifications (user_id, title, message, type, reference_id)
         SELECT gm.user_id, $1, $2, 'emergency', gm.group_id
           FROM group_members gm
          WHERE gm.group_id = $3 AND gm.status = 'active' AND gm.user_id <> $4`,
        [
          truncate(`SOS from ${senderName}`, TITLE_MAX_LENGTH),
          `${senderName} raised an SOS in your group "${groupName}". Open the group to see where they are.`,
          groupId,
          senderId,
        ]
      );
      return result.rowCount || 0;
    } catch (err) {
      console.error(`Group SOS notification failed for group ${groupId}:`, err.message);
      return -1;
    }
  };

  /**
   * Saves a check-in for members who do not have the app open, so "I'm safe"
   * still reaches them later. Like the SOS row, it carries no coordinates.
   *
   * Never throws. Returns the number notified, or -1 when the insert failed.
   */
  const notifyCheckInToMembers = async (groupId, senderId, senderName, groupName) => {
    try {
      const result = await query(
        `INSERT INTO notifications (user_id, title, message, type, reference_id)
         SELECT gm.user_id, $1, $2, 'group', gm.group_id
           FROM group_members gm
          WHERE gm.group_id = $3 AND gm.status = 'active' AND gm.user_id <> $4`,
        [
          truncate(`${senderName} checked in`, TITLE_MAX_LENGTH),
          `${senderName} checked in and is safe, in your group "${groupName}".`,
          groupId,
          senderId,
        ]
      );
      return result.rowCount || 0;
    } catch (err) {
      console.error(`Group check-in notification failed for group ${groupId}:`, err.message);
      return -1;
    }
  };

  /** Active members other than [userId]. Never throws; null when the read failed. */
  const loadOtherActiveMemberIds = async (groupId, userId) => {
    try {
      const result = await query(
        `SELECT user_id FROM group_members
          WHERE group_id = $1 AND status = 'active' AND user_id <> $2`,
        [groupId, userId]
      );
      return result.rows.map((row) => row.user_id);
    } catch (err) {
      console.error(`Loading members to notify of deletion of group ${groupId} failed:`, err.message);
      return null;
    }
  };

  /**
   * Tells former members the group is gone. Runs after the delete, when the
   * group_members rows have already cascaded away, so recipients are passed in.
   * A single uuid[] parameter keeps the bound-parameter count fixed however
   * large the group is.
   *
   * Never throws. Returns the number notified, or -1 when the insert failed.
   */
  const notifyGroupDeleted = async (groupId, groupName, recipientIds) => {
    if (recipientIds.length === 0) return 0;
    try {
      const result = await query(
        `INSERT INTO notifications (user_id, title, message, type, reference_id)
         SELECT recipient, $1, $2, 'group', $3
           FROM unnest($4::uuid[]) AS recipient`,
        ['Group deleted', `${groupName} was deleted by its creator`, groupId, recipientIds]
      );
      return result.rowCount || 0;
    } catch (err) {
      console.error(`Group deletion notification failed for group ${groupId}:`, err.message);
      return -1;
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

      const deliveredLive = broadcastToOthers(id, req.user.id, frame);
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

      const deliveredLive = broadcastToOthers(id, req.user.id, frame);
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

      const notified = recipients === null
        ? -1
        : await notifyGroupDeleted(id, group.group_name, recipients);

      return success(res, { delivered_live: deliveredLive, notified }, 'Group deleted');
    } catch (err) {
      console.error(`Delete group error (group ${id}, user ${req.user && req.user.id}):`, err);
      return error(res, 'Failed to delete group', 500);
    }
  };

  return { sendSos, checkIn, deleteGroup };
};

const { sendSos, checkIn, deleteGroup } = buildGroupEventHandlers({
  query: db.query,
  broadcastToGroup: ws.broadcastToGroup,
  isMemberConnected: ws.isMemberConnected,
});

module.exports = { buildGroupEventHandlers, sendSos, checkIn, deleteGroup, NOTE_MAX_LENGTH };
