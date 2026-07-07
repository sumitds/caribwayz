const { query } = require('../config/db');
const { success, created, error, notFound, forbidden } = require('../utils/response');

const triggerEmergency = async (req, res) => {
  try {
    const { type, latitude, longitude, description } = req.body;

    const result = await query(
      `INSERT INTO emergency_alerts (user_id, type, latitude, longitude, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.user.id, type, latitude, longitude, description]
    );

    const alert = result.rows[0];

    // Notify via Firebase Cloud Messaging (if configured)
    try {
      const { getMessaging } = require('../config/firebase');
      const messaging = getMessaging();
      if (messaging) {
        await messaging.send({
          topic: 'emergency_alerts',
          notification: {
            title: `EMERGENCY: ${type.toUpperCase()}`,
            body: `Emergency reported near your area. Stay alert.`,
          },
          data: {
            emergency_id: alert.id,
            type: alert.type,
            latitude: String(alert.latitude),
            longitude: String(alert.longitude),
          },
          android: { priority: 'high' },
          apns: { payload: { aps: { contentAvailable: true } } },
        });
      }
    } catch (fcmErr) {
      console.warn('FCM notification failed:', fcmErr.message);
    }

    return created(res, { alert }, 'Emergency alert triggered');
  } catch (err) {
    console.error('Trigger emergency error:', err);
    return error(res, 'Failed to trigger emergency alert', 500);
  }
};

const getEmergencyStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query('SELECT * FROM emergency_alerts WHERE id = $1', [id]);
    if (result.rows.length === 0) return notFound(res, 'Emergency alert not found');
    return success(res, { alert: result.rows[0] });
  } catch (err) {
    console.error('Get emergency error:', err);
    return error(res, 'Failed to fetch emergency alert', 500);
  }
};

const resolveEmergency = async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await query('SELECT user_id FROM emergency_alerts WHERE id = $1', [id]);
    if (existing.rows.length === 0) return notFound(res, 'Emergency alert not found');

    if (existing.rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
      return forbidden(res, 'Not authorized to resolve this alert');
    }

    const result = await query(
      `UPDATE emergency_alerts SET status = 'resolved', resolved_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id]
    );

    return success(res, { alert: result.rows[0] }, 'Emergency resolved');
  } catch (err) {
    console.error('Resolve emergency error:', err);
    return error(res, 'Failed to resolve emergency', 500);
  }
};

module.exports = { triggerEmergency, getEmergencyStatus, resolveEmergency };
