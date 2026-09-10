const { query } = require('../config/db');
const { haversineDistance, estimateETA } = require('../utils/haversine');
const { resolveResponderAccess } = require('../middleware/auth');
const { success, created, error, notFound, forbidden } = require('../utils/response');

/**
 * Emergency types accepted by the emergency_alerts CHECK constraint.
 *
 * Kept here so a bad type is rejected with a readable message naming the valid
 * values, instead of surfacing as a raw Postgres constraint violation that the
 * caller cannot act on.
 */
const EMERGENCY_TYPES = ['fire', 'medical', 'accident', 'breakdown', 'crime', 'other'];

const ALERT_STATUSES = ['active', 'resolved'];

/**
 * Hard ceiling on rows pulled from the table for one feed request.
 *
 * Distance filtering and ordering happen in JS, so this cap is applied to the
 * candidate set, never to the answer -- truncating before the distance sort is
 * what would hide the nearest emergency from the responder driving to it.
 */
const MAX_CANDIDATE_ALERTS = 1000;

/**
 * Writes an in-app notification to every approved responder.
 *
 * This is the delivery path that actually works today: the mobile client has no
 * FCM messaging integration yet, so a topic push reaches nobody, while these
 * rows are served by GET /api/v1/notifications and survive the responder being
 * offline when the alert was raised.
 *
 * The notification deliberately carries no coordinates and no reporter detail.
 * Notification rows are readable with only `authenticate`, they persist after
 * an account is demoted, and they are pageable as an archive -- so they hold a
 * reference_id and the responder opens the alert through the gated endpoint,
 * where access is re-checked at read time.
 *
 * Never throws. A notification failure must not fail the alert itself.
 * Returns the number of responders notified, or -1 when delivery failed, so the
 * caller can tell "nobody is registered" apart from "we could not tell".
 */
const notifyResponders = async (alert) => {
  try {
    // INSERT ... SELECT keeps this at three bound parameters no matter how many
    // responders exist. Building one placeholder pair per responder would send
    // 3 + N parameters and break past the wire protocol's parameter ceiling,
    // silently stopping every notification for every emergency.
    const result = await query(
      `INSERT INTO notifications (user_id, title, message, type, reference_id)
       SELECT id, $1, $2, 'emergency', $3
         FROM users
        WHERE status = 'active'
          AND (is_responder = TRUE OR role = 'admin')`,
      [
        `EMERGENCY: ${String(alert.type).toUpperCase()}`,
        'A CaribWayz user has raised an emergency. Open the Emergencies panel for the location.',
        alert.id,
      ]
    );

    return result.rowCount || 0;
  } catch (err) {
    // Logged at error level with the alert id: a total notification outage is
    // otherwise invisible, and every caller would be told "no responders".
    console.error(
      `Responder notification failed for alert ${alert && alert.id}:`,
      err.message
    );
    return -1;
  }
};

const triggerEmergency = async (req, res) => {
  try {
    const { type, latitude, longitude, description } = req.body;

    if (!EMERGENCY_TYPES.includes(type)) {
      return error(
        res,
        `Invalid emergency type. Must be one of: ${EMERGENCY_TYPES.join(', ')}`,
        400
      );
    }

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 ||
        !Number.isFinite(lng) || Math.abs(lng) > 180) {
      return error(res, 'Latitude and longitude must be a valid coordinate', 400);
    }

    const result = await query(
      `INSERT INTO emergency_alerts (user_id, type, latitude, longitude, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.user.id, type, lat, lng, description]
    );

    const alert = result.rows[0];

    const notified = await notifyResponders(alert);

    // Firebase Cloud Messaging, when configured. No mobile client subscribes to
    // this topic yet, so it is not the delivery path -- notifyResponders above
    // is. Left in place for when push notifications land in Milestone 2.
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
          },
          android: { priority: 'high' },
          apns: { payload: { aps: { contentAvailable: true } } },
        });
      }
    } catch (fcmErr) {
      console.warn('FCM notification failed:', fcmErr.message);
    }

    // responders_notified lets the client tell the user whether anyone was
    // actually reachable, instead of implying help is coming when no responder
    // account exists in their territory yet. -1 means delivery itself failed.
    return created(
      res,
      { alert, responders_notified: notified },
      'Emergency alert triggered'
    );
  } catch (err) {
    console.error('Trigger emergency error:', err);
    return error(res, 'Failed to trigger emergency alert', 500);
  }
};

/**
 * The responder feed: active emergency alerts, nearest first.
 *
 * Gated by requireResponder. These rows are live locations of people in
 * trouble, so this must never be readable by an ordinary driver account.
 *
 * Query parameters:
 *   lat, lng  optional; when both are given, results are ordered by distance
 *             from that point and annotated with distance_km and eta_minutes
 *   radius    optional km limit; ignored unless lat and lng are both present
 *   status    active (default); resolved is admin-only, because the resolved
 *             set is a historical archive of where people have been
 *   limit     1-200, default 100, applied after the distance sort
 */
const listEmergencies = async (req, res) => {
  try {
    const { lat, lng, radius, status = 'active' } = req.query;

    if (!ALERT_STATUSES.includes(status)) {
      return error(
        res,
        `Invalid status. Must be one of: ${ALERT_STATUSES.join(', ')}`,
        400
      );
    }

    if (status === 'resolved' && req.user.role !== 'admin') {
      return forbidden(res, 'Only an administrator can list resolved alerts');
    }

    const parsedLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 200)
      : 100;

    // reporter_emergency_contact is deliberately absent. It belongs to a third
    // party who has not raised an emergency, the responder does not need it to
    // attend the scene, and the client never read it.
    const result = await query(
      `SELECT a.id, a.type, a.latitude, a.longitude, a.description, a.status,
              a.created_at, a.resolved_at,
              u.id   AS reporter_id,
              u.name AS reporter_name,
              u.phone AS reporter_phone
         FROM emergency_alerts a
         JOIN users u ON u.id = a.user_id
        WHERE a.status = $1
        ORDER BY a.created_at DESC
        LIMIT $2`,
      [status, MAX_CANDIDATE_ALERTS]
    );

    let alerts = result.rows.map((row) => ({
      ...row,
      // Postgres returns DECIMAL as a string; the client parses these as
      // coordinates and must not receive "18.01790000".
      latitude: parseFloat(row.latitude),
      longitude: parseFloat(row.longitude),
    }));

    const originLat = parseFloat(lat);
    const originLng = parseFloat(lng);
    const hasOrigin =
      Number.isFinite(originLat) && Math.abs(originLat) <= 90 &&
      Number.isFinite(originLng) && Math.abs(originLng) <= 180;

    if (hasOrigin) {
      alerts = alerts.map((alert) => {
        const distanceKm = haversineDistance(
          originLat, originLng, alert.latitude, alert.longitude
        );
        return {
          ...alert,
          distance_km: parseFloat(distanceKm.toFixed(2)),
          eta_minutes: estimateETA(distanceKm),
        };
      });

      const radiusKm = parseFloat(radius);
      if (Number.isFinite(radiusKm) && radiusKm > 0) {
        alerts = alerts.filter((alert) => alert.distance_km <= radiusKm);
      }

      alerts.sort((a, b) => a.distance_km - b.distance_km);
    }

    // Applied last, so the nearest alerts survive the cut rather than the
    // most recently created ones.
    const page = alerts.slice(0, limit);

    return success(res, {
      alerts: page,
      count: page.length,
      total_matched: alerts.length,
      truncated: result.rows.length >= MAX_CANDIDATE_ALERTS,
    });
  } catch (err) {
    console.error('List emergencies error:', err);
    return error(res, 'Failed to fetch emergency alerts', 500);
  }
};

/**
 * Whether the requesting user may act on an alert they do not own.
 *
 * Delegates to the same check the feed middleware uses, so a change to who
 * counts as a responder cannot apply to the list endpoint while leaving the
 * per-id endpoints open.
 */
const canActAsResponder = async (req) => {
  try {
    const access = await resolveResponderAccess(req.user.id);
    return access.allowed === true;
  } catch (err) {
    console.error('Responder check error:', err);
    // Fail closed.
    return false;
  }
};

const getEmergencyStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(
      `SELECT a.*, u.name AS reporter_name, u.phone AS reporter_phone
         FROM emergency_alerts a
         JOIN users u ON u.id = a.user_id
        WHERE a.id = $1`,
      [id]
    );
    if (result.rows.length === 0) return notFound(res, 'Emergency alert not found');

    const alert = result.rows[0];

    // An alert carries a live location and a phone number. Previously any
    // authenticated account could read any alert by guessing or replaying an
    // id; it is now restricted to the person who raised it and the responders
    // who are supposed to act on it.
    const isOwner = alert.user_id === req.user.id;
    if (!isOwner && !(await canActAsResponder(req))) {
      return forbidden(res, 'Not authorized to view this alert');
    }

    return success(res, {
      alert: {
        ...alert,
        latitude: parseFloat(alert.latitude),
        longitude: parseFloat(alert.longitude),
      },
    });
  } catch (err) {
    console.error('Get emergency error:', err);
    return error(res, 'Failed to fetch emergency alert', 500);
  }
};

const resolveEmergency = async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await query(
      'SELECT * FROM emergency_alerts WHERE id = $1',
      [id]
    );
    if (existing.rows.length === 0) return notFound(res, 'Emergency alert not found');

    const current = existing.rows[0];
    const isOwner = current.user_id === req.user.id;

    // A responder who has attended the scene can close the alert; otherwise an
    // alert whose sender is unable to cancel it stays active forever.
    if (!isOwner && !(await canActAsResponder(req))) {
      return forbidden(res, 'Not authorized to resolve this alert');
    }

    if (current.status === 'resolved') {
      // Idempotent: a double tap from a responder must not look like a failure.
      return success(res, { alert: current }, 'Emergency already resolved');
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

module.exports = {
  triggerEmergency,
  listEmergencies,
  getEmergencyStatus,
  resolveEmergency,
  EMERGENCY_TYPES,
};
