const { query } = require('../config/db');
const { success, created, error, notFound, forbidden } = require('../utils/response');
const { getRealtimeDB } = require('../config/firebase');
const { sendGroupInvite } = require('../services/emailService');
const { broadcastLocation } = require('../services/wsService');
const { displayName } = require('../utils/displayName');
const { blockedWithSubquery, notBlockedBetween, idList } = require('../services/blockService');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One coordinate from a request body: the number, or null when it is absent,
 * not a number, or outside +/-[limit]. Numeric strings are accepted.
 */
const readCoordinate = (value, limit) => {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  else return null;
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
};

const generateJoinCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
};

const createGroup = async (req, res) => {
  try {
    const { group_name, destination_lat, destination_lng, destination_address } = req.body;

    let join_code;
    let attempts = 0;
    do {
      join_code = generateJoinCode();
      const exists = await query('SELECT id FROM groups WHERE join_code = $1', [join_code]);
      if (exists.rows.length === 0) break;
      attempts++;
    } while (attempts < 10);

    const groupResult = await query(
      `INSERT INTO groups (group_name, join_code, destination_lat, destination_lng, destination_address, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [group_name, join_code, destination_lat, destination_lng, destination_address, req.user.id]
    );

    const group = groupResult.rows[0];

    await query(
      `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`,
      [group.id, req.user.id]
    );

    return created(res, { group }, 'Group created successfully');
  } catch (err) {
    console.error('Create group error:', err);
    return error(res, 'Failed to create group', 500);
  }
};

const joinGroup = async (req, res) => {
  try {
    const { join_code, current_latitude, current_longitude } = req.body;

    const groupResult = await query('SELECT * FROM groups WHERE join_code = $1', [join_code]);
    if (groupResult.rows.length === 0) return notFound(res, 'Invalid join code');

    const group = groupResult.rows[0];

    // Someone in the group blocked this person, who would otherwise be one
    // join code away from their live location. The message does not say who.
    const blockedBy = await query(
      `SELECT 1 FROM group_members gm
         JOIN user_blocks ub ON ub.blocker_id = gm.user_id
        WHERE gm.group_id = $1 AND gm.status = 'active' AND ub.blocked_id = $2
        LIMIT 1`,
      [group.id, req.user.id]
    );
    if (blockedBy.rows.length > 0) return forbidden(res, "You can't join this group.");

    const existing = await query(
      'SELECT id, status FROM group_members WHERE group_id = $1 AND user_id = $2',
      [group.id, req.user.id]
    );

    if (existing.rows.length > 0) {
      if (existing.rows[0].status === 'active') {
        return error(res, 'You are already a member of this group', 409);
      }
      await query(
        `UPDATE group_members
         SET status = 'active', joined_at = NOW(),
             current_latitude = $1, current_longitude = $2, location_updated_at = NOW()
         WHERE group_id = $3 AND user_id = $4`,
        [current_latitude ?? null, current_longitude ?? null, group.id, req.user.id]
      );
    } else {
      await query(
        `INSERT INTO group_members (group_id, user_id, current_latitude, current_longitude, location_updated_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [group.id, req.user.id, current_latitude ?? null, current_longitude ?? null,
         current_latitude ? new Date() : null]
      );
    }

    return success(res, { group }, 'Joined group successfully');
  } catch (err) {
    console.error('Join group error:', err);
    return error(res, 'Failed to join group', 500);
  }
};

const getGroupDetails = async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_PATTERN.test(String(id))) return error(res, 'Group id must be a valid UUID', 400);

    // Members' last known locations are in this answer, so only a member (or
    // an admin) may read it. Checked before the group itself, so an outsider
    // cannot even learn whether a group id exists.
    if (req.user.role !== 'admin') {
      const membership = await query(
        `SELECT 1 FROM group_members
          WHERE group_id = $1 AND user_id = $2 AND status = 'active'`,
        [id, req.user.id]
      );
      if (membership.rows.length === 0) return forbidden(res, 'Not a member of this group');
    }

    const groupResult = await query('SELECT * FROM groups WHERE id = $1', [id]);
    if (groupResult.rows.length === 0) return notFound(res, 'Group not found');

    // Anyone in a block with the caller is left out, so neither sees the
    // other's last known location here.
    const membersResult = await query(
      `SELECT gm.id, gm.user_id, gm.joined_at, gm.status,
              gm.current_latitude, gm.current_longitude, gm.location_updated_at,
              u.name, u.profile_image
       FROM group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_id = $1 AND gm.status = 'active'
         AND ${notBlockedBetween('$2', 'gm.user_id')}`,
      [id, req.user.id]
    );

    const members = membersResult.rows;

    return success(res, { group: groupResult.rows[0], members });
  } catch (err) {
    console.error('Get group error:', err);
    return error(res, 'Failed to fetch group', 500);
  }
};

const leaveGroup = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `UPDATE group_members SET status = 'left'
       WHERE group_id = $1 AND user_id = $2 AND status = 'active'`,
      [id, req.user.id]
    );

    if (result.rowCount === 0) return notFound(res, 'Group membership not found');

    // Clean up Firebase location when user leaves
    try {
      const db = getRealtimeDB();
      if (db) {
        await db.ref(`groups/${id}/locations/${req.user.id}`).remove();
      }
    } catch (fbErr) {
      console.warn('Firebase cleanup error:', fbErr.message);
    }

    return success(res, {}, 'Left group successfully');
  } catch (err) {
    console.error('Leave group error:', err);
    return error(res, 'Failed to leave group', 500);
  }
};

const updateLocation = async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_PATTERN.test(String(id))) return error(res, 'Group id must be a valid UUID', 400);

    // The app sends current_latitude/current_longitude (the names joining a
    // group uses); latitude/longitude is accepted too, for any client that
    // followed the API docs.
    const body = req.body || {};
    const rawLatitude = body.current_latitude !== undefined ? body.current_latitude : body.latitude;
    const rawLongitude = body.current_longitude !== undefined ? body.current_longitude : body.longitude;
    const latitude = readCoordinate(rawLatitude, 90);
    const longitude = readCoordinate(rawLongitude, 180);
    if (latitude === null || longitude === null) {
      return error(res, 'current_latitude (-90 to 90) and current_longitude (-180 to 180) are required', 400);
    }

    // The token carries only { id, email, role }, so the sender's name for the
    // live frame is read alongside the membership check, with the people in a
    // block with the sender, who must not get their position.
    const member = await query(
      `SELECT gm.id, u.name AS user_name, ARRAY${blockedWithSubquery('$2')} AS blocked_with
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = $1 AND gm.user_id = $2 AND gm.status = 'active'`,
      [id, req.user.id]
    );
    if (member.rows.length === 0) return forbidden(res, 'Not a member of this group');

    const db = getRealtimeDB();
    if (db) {
      await db.ref(`groups/${id}/locations/${req.user.id}`).set({
        lat: latitude,
        lng: longitude,
        updatedAt: Date.now(),
      });
    }

    // Broadcast to all WebSocket clients in this group room
    broadcastLocation(
      id, req.user.id, displayName(member.rows[0].user_name), latitude, longitude,
      idList(member.rows[0].blocked_with)
    );

    return success(res, {}, 'Location updated');
  } catch (err) {
    console.error('Update location error:', err);
    return error(res, 'Failed to update location', 500);
  }
};

const getGroupsByUser = async (req, res) => {
  try {
    const { user_id } = req.params;

    // Rows include each group's join_code, which admits anyone to the group's
    // live member locations, so only the user themselves or an admin may list.
    if (user_id !== req.user.id && req.user.role !== 'admin') {
      return forbidden(res, 'You can only list your own groups');
    }

    const result = await query(
      `SELECT g.*, gm.joined_at, gm.status AS member_status,
              u.name AS created_by_name
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id
       JOIN users u ON u.id = g.created_by
       WHERE gm.user_id = $1 AND gm.status = 'active'
       ORDER BY gm.joined_at DESC`,
      [user_id]
    );

    return success(res, { groups: result.rows, total: result.rowCount });
  } catch (err) {
    console.error('Get groups by user error:', err);
    return error(res, 'Failed to fetch groups', 500);
  }
};

/** Anything shaped like an email address, for scrubbing addresses out of logs. */
const EMAIL_ADDRESS = /[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g;

const inviteToGroup = async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.body;

    const groupResult = await query('SELECT * FROM groups WHERE id = $1', [id]);
    if (groupResult.rows.length === 0) return notFound(res, 'Group not found');

    const group = groupResult.rows[0];

    const member = await query(
      `SELECT gm.id, u.name AS user_name
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = $1 AND gm.user_id = $2 AND gm.status = 'active'`,
      [id, req.user.id]
    );
    if (member.rows.length === 0) return forbidden(res, 'Only group members can send invites');

    // Accounts in a block with the inviter. Inviting someone you blocked is
    // refused and said plainly; someone who blocked you is quietly left off,
    // because telling you would tell you that they blocked you.
    const blocked = await query(
      `SELECT LOWER(u.email) AS email,
              EXISTS (SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = u.id) AS blocked_by_inviter
         FROM users u
        WHERE LOWER(u.email) = ANY($2::text[])
          AND NOT ${notBlockedBetween('$1', 'u.id')}`,
      [req.user.id, email.map((address) => String(address).trim().toLowerCase())]
    );
    if (blocked.rows.some((row) => row.blocked_by_inviter)) {
      return error(res, 'You blocked someone on this list. Unblock them in Settings, Privacy & Security, Blocked people, to invite them.', 400);
    }
    const leftOff = new Set(blocked.rows.map((row) => row.email));
    const recipients = email.filter((address) => !leftOff.has(String(address).trim().toLowerCase()));

    if (recipients.length > 0) {
      await sendGroupInvite({
        toEmails: recipients,
        groupName: group.group_name,
        joinCode: group.join_code,
        inviterName: displayName(member.rows[0].user_name),
      });
    }

    // Counted as sent to everyone asked for, for the reason above.
    return success(res, { invited: email.length }, `Invitation sent to ${email.length} recipient(s)`);
  } catch (err) {
    // A mail server's error usually quotes the address it refused; the log
    // keeps the reason and drops every address.
    const logged = String(err.message || err).replace(EMAIL_ADDRESS, '[address]');
    console.error(`Invite to group error (group ${req.params.id}${err.code ? `, ${err.code}` : ''}):`, logged);
    // No counts reach the inviter: they are of the addresses actually mailed,
    // which would show that someone who blocked them was left off. Nor does
    // the mail server's own text, which can name other people's addresses.
    const reason = err.detail || err.message;
    const msg = reason?.includes('SMTP') || reason?.includes('auth') || err.code === 'EAUTH'
      ? 'Email service not configured — check SMTP_USER and SMTP_PASS on the server'
      : err.sent > 0
        ? 'Some invitations could not be sent. Please try again.'
        : 'The invitations could not be sent. Please try again.';
    return error(res, msg, 500);
  }
};

module.exports = { createGroup, joinGroup, getGroupDetails, leaveGroup, updateLocation, inviteToGroup, getGroupsByUser };
