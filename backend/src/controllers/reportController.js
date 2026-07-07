const { query } = require('../config/db');
const { haversineDistance } = require('../utils/haversine');
const { success, created, error, notFound } = require('../utils/response');

const REPORT_EXPIRY_HOURS = parseInt(process.env.REPORT_EXPIRY_HOURS) || 4;

const submitReport = async (req, res) => {
  try {
    const { type, latitude, longitude, severity, description } = req.body;
    const expiresAt = new Date(Date.now() + REPORT_EXPIRY_HOURS * 60 * 60 * 1000);

    const result = await query(
      `INSERT INTO reports (user_id, type, latitude, longitude, severity, description, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.user.id, type, latitude, longitude, severity || 'medium', description, expiresAt]
    );

    return created(res, { report: result.rows[0] }, 'Report submitted successfully');
  } catch (err) {
    console.error('Submit report error:', err);
    return error(res, 'Failed to submit report', 500);
  }
};

const getNearbyReports = async (req, res) => {
  try {
    const { lat, lng, radius = 5, type } = req.query;

    if (!lat || !lng) {
      return error(res, 'lat and lng query params are required', 400);
    }

    let sql = `SELECT r.*, u.name as reporter_name
               FROM reports r
               JOIN users u ON r.user_id = u.id
               WHERE r.status = 'active' AND (r.expires_at IS NULL OR r.expires_at > NOW())`;
    const params = [];

    if (type) {
      params.push(type);
      sql += ` AND r.type = $${params.length}`;
    }

    const result = await query(sql, params);
    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);
    const radiusKm = parseFloat(radius);

    const nearby = result.rows
      .map(r => ({
        ...r,
        distance_km: parseFloat(haversineDistance(userLat, userLng, r.latitude, r.longitude).toFixed(2)),
      }))
      .filter(r => r.distance_km <= radiusKm)
      .sort((a, b) => a.distance_km - b.distance_km);

    return success(res, { reports: nearby, count: nearby.length });
  } catch (err) {
    console.error('Get nearby reports error:', err);
    return error(res, 'Failed to fetch reports', 500);
  }
};

const confirmReport = async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await query(
      'SELECT id FROM report_confirmations WHERE report_id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (existing.rows.length > 0) {
      return error(res, 'You have already confirmed this report', 409);
    }

    await query(
      'INSERT INTO report_confirmations (report_id, user_id) VALUES ($1, $2)',
      [id, req.user.id]
    );

    const result = await query(
      `UPDATE reports SET confirmed_count = confirmed_count + 1
       WHERE id = $1 AND status = 'active' RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) return notFound(res, 'Report not found or expired');

    return success(res, { report: result.rows[0] }, 'Report confirmed');
  } catch (err) {
    console.error('Confirm report error:', err);
    return error(res, 'Failed to confirm report', 500);
  }
};

module.exports = { submitReport, getNearbyReports, confirmReport };
