const { query } = require('../config/db');
const { success, error } = require('../utils/response');

const getNotifications = async (req, res) => {
  try {
    const { limit = 30, offset = 0, unread_only } = req.query;
    let sql = `SELECT * FROM notifications WHERE user_id = $1`;
    const params = [req.user.id];

    if (unread_only === 'true') {
      sql += ` AND is_read = FALSE`;
    }

    sql += ` ORDER BY created_at DESC LIMIT $2 OFFSET $3`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(sql, params);
    const countResult = await query(
      `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = FALSE`,
      [req.user.id]
    );

    return success(res, {
      notifications: result.rows,
      unread_count: parseInt(countResult.rows[0].count),
    });
  } catch (err) {
    console.error('Get notifications error:', err);
    return error(res, 'Failed to fetch notifications', 500);
  }
};

const markAsRead = async (req, res) => {
  try {
    const { notification_ids } = req.body;

    if (notification_ids && notification_ids.length > 0) {
      await query(
        `UPDATE notifications SET is_read = TRUE
         WHERE user_id = $1 AND id = ANY($2::uuid[])`,
        [req.user.id, notification_ids]
      );
    } else {
      // Mark all as read
      await query(
        'UPDATE notifications SET is_read = TRUE WHERE user_id = $1',
        [req.user.id]
      );
    }

    return success(res, {}, 'Notifications marked as read');
  } catch (err) {
    console.error('Mark read error:', err);
    return error(res, 'Failed to mark notifications', 500);
  }
};

module.exports = { getNotifications, markAsRead };
