const { query } = require('../config/db');
const { haversineDistance } = require('../utils/haversine');
const { success, created, error, notFound, forbidden } = require('../utils/response');
const { notify } = require('../services/notificationService');

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

/** How a report type reads in a sentence. The app calls construction reports
 * "Roadworks", so the server says the same. */
const reportTypeLabel = (type) =>
  type === 'construction' ? 'roadworks' : String(type).replace(/_/g, ' ');

const confirmReport = async (req, res) => {
  try {
    const { id } = req.params;

    // Confirming your own report would let one driver lift it past every
    // "verified reports only" filter.
    const report = await query('SELECT user_id FROM reports WHERE id = $1', [id]);
    if (report.rows.length === 0) return notFound(res, 'Report not found or expired');
    if (String(report.rows[0].user_id).toLowerCase() === String(req.user.id).toLowerCase()) {
      return forbidden(res, 'You cannot confirm your own report');
    }

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

    // Tell the reporter someone on the road saw it too. Own reports were
    // refused above, so this never thanks people for confirming themselves.
    // notify() never throws: a failed notice does not undo the confirmation.
    const confirmed = result.rows[0];
    await notify([confirmed.user_id], {
      type: 'report',
      category: 'reports',
      title: 'Your report was confirmed',
      message: `Another driver confirmed your ${reportTypeLabel(confirmed.type)} report. Thanks for keeping the road safe.`,
      reference_id: confirmed.id,
    });

    return success(res, { report: confirmed }, 'Report confirmed');
  } catch (err) {
    console.error('Confirm report error:', err);
    return error(res, 'Failed to confirm report', 500);
  }
};

const getReportHistory = async (req, res) => {
  try {
    const { user_id } = req.params;
    const { type, status, limit = 20, offset = 0 } = req.query;

    const params = [user_id];
    let filters = '';

    if (type) {
      params.push(type);
      filters += ` AND r.type = $${params.length}`;
    }
    if (status) {
      params.push(status);
      filters += ` AND r.status = $${params.length}`;
    }

    params.push(parseInt(limit), parseInt(offset));

    const result = await query(
      `SELECT r.*,
              CASE WHEN r.expires_at < NOW() THEN 'expired' ELSE r.status END AS current_status
       FROM reports r
       WHERE r.user_id = $1 ${filters}
       ORDER BY r.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countResult = await query(
      `SELECT COUNT(*) FROM reports r WHERE r.user_id = $1 ${filters}`,
      params.slice(0, params.length - 2)
    );

    return success(res, {
      reports: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (err) {
    console.error('Get report history error:', err);
    return error(res, 'Failed to fetch report history', 500);
  }
};

module.exports = { submitReport, getNearbyReports, confirmReport, getReportHistory, reportTypeLabel };
