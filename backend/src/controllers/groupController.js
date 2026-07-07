const { query } = require('../config/db');
const { success, created, error, notFound, forbidden } = require('../utils/response');
const { getRealtimeDB } = require('../config/firebase');

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
    const { join_code } = req.body;

    const groupResult = await query('SELECT * FROM groups WHERE join_code = $1', [join_code]);
    if (groupResult.rows.length === 0) return notFound(res, 'Invalid join code');

    const group = groupResult.rows[0];

    const existing = await query(
      'SELECT id, status FROM group_members WHERE group_id = $1 AND user_id = $2',
      [group.id, req.user.id]
    );

    if (existing.rows.length > 0) {
      if (existing.rows[0].status === 'active') {
        return error(res, 'You are already a member of this group', 409);
      }
      await query(
        'UPDATE group_members SET status = $1, joined_at = NOW() WHERE group_id = $2 AND user_id = $3',
        ['active', group.id, req.user.id]
      );
    } else {
      await query(
        'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)',
        [group.id, req.user.id]
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

    const groupResult = await query('SELECT * FROM groups WHERE id = $1', [id]);
    if (groupResult.rows.length === 0) return notFound(res, 'Group not found');

    const membersResult = await query(
      `SELECT gm.id, gm.user_id, gm.joined_at, gm.status, u.name, u.profile_image
       FROM group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_id = $1 AND gm.status = 'active'`,
      [id]
    );

    return success(res, { group: groupResult.rows[0], members: membersResult.rows });
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
    const { latitude, longitude } = req.body;

    const member = await query(
      `SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2 AND status = 'active'`,
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

    return success(res, {}, 'Location updated');
  } catch (err) {
    console.error('Update location error:', err);
    return error(res, 'Failed to update location', 500);
  }
};

module.exports = { createGroup, joinGroup, getGroupDetails, leaveGroup, updateLocation };
