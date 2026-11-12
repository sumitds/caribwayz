const { query } = require('../config/db');
const { haversineDistance, estimateETA } = require('../utils/haversine');
const { resolveResponderAccess } = require('../middleware/auth');
const { success, created, error, notFound, forbidden } = require('../utils/response');
const { displayName } = require('../utils/displayName');
const { notify } = require('../services/notificationService');
const { notifyContactsOfAlert, notifyContactsResolved } = require('../services/contactAlertService');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 409 Conflict, with the current alert so the caller can show who has it. */
const conflict = (res, message, alert) =>
  res.status(409).json({ success: false, message, data: { alert } });

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
 * Notifies every approved responder: a row in their notification list, and a
 * push to their phones when they have emergency pushes on.
 *
 * The notification deliberately carries no coordinates and no reporter detail.
 * Notification rows are readable with only `authenticate`, they persist after
 * an account is demoted, and they are pageable as an archive -- so they hold a
 * reference_id and the responder opens the alert through the gated endpoint,
 * where access is re-checked at read time. The push carries the same text.
 *
 * Never throws. A notification failure must not fail the alert itself.
 * Returns the number of responders notified, or -1 when delivery failed, so the
 * caller can tell "nobody is registered" apart from "we could not tell".
 */
const notifyResponders = async (alert) => {
  let responderIds;
  try {
    const result = await query(
      `SELECT id FROM users
        WHERE status = 'active'
          AND (is_responder = TRUE OR role = 'admin')`
    );
    responderIds = result.rows.map((row) => row.id);
  } catch (err) {
    // Logged at error level with the alert id: a total notification outage is
    // otherwise invisible, and every caller would be told "no responders".
    console.error(
      `Responder notification failed for alert ${alert && alert.id}:`,
      err.message
    );
    return -1;
  }

  // notify() writes the rows with one uuid[] parameter, so the statement has a
  // fixed parameter count however many responders exist, and never throws.
  return notify(responderIds, {
    type: 'emergency',
    category: 'emergency',
    title: `EMERGENCY: ${String(alert.type).toUpperCase()}`,
    message: 'A CaribWayz user has raised an emergency. Open the Emergencies panel for the location.',
    reference_id: alert.id,
  });
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

    // Neither throws; the two audiences are told at the same time.
    const [notified, contactsNotified] = await Promise.all([
      notifyResponders(alert),
      notifyContactsOfAlert(alert),
    ]);

    // responders_notified lets the client tell the user whether anyone was
    // actually reachable, instead of implying help is coming when no responder
    // account exists in their territory yet. -1 means delivery itself failed.
    // contacts_notified is the same for trusted contacts who use CaribWayz.
    return created(
      res,
      { alert, responders_notified: notified, contacts_notified: contactsNotified },
      'Emergency alert triggered'
    );
  } catch (err) {
    console.error('Trigger emergency error:', err);
    return error(res, 'Failed to trigger emergency alert', 500);
  }
};

/**
 * Adds desk_state ('new' | 'acknowledged' | 'resolved') and readable operator
 * names. acknowledged_at is the flag: a deleted operator account leaves the
 * alert taken, by "a former operator".
 */
const withDeskState = (row) => {
  const deskState = row.status === 'resolved'
    ? 'resolved'
    : row.acknowledged_at ? 'acknowledged' : 'new';
  const out = { ...row, desk_state: deskState };
  if ('acknowledged_by_name' in row) {
    out.acknowledged_by_name = row.acknowledged_at
      ? displayName(row.acknowledged_by_name, row.acknowledged_by ? 'An operator' : 'A former operator')
      : null;
  }
  if ('resolved_by_name' in row) {
    out.resolved_by_name = row.resolved_by ? displayName(row.resolved_by_name, 'An operator') : null;
  }
  return out;
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
              a.acknowledged_at, a.acknowledged_by, op.name AS acknowledged_by_name,
              a.resolved_by, rb.name AS resolved_by_name,
              u.id   AS reporter_id,
              u.name AS reporter_name,
              u.phone AS reporter_phone
         FROM emergency_alerts a
         JOIN users u ON u.id = a.user_id
         LEFT JOIN users op ON op.id = a.acknowledged_by
         LEFT JOIN users rb ON rb.id = a.resolved_by
        WHERE a.status = $1
        ORDER BY a.created_at DESC
        LIMIT $2`,
      [status, MAX_CANDIDATE_ALERTS]
    );

    let alerts = result.rows.map((row) => ({
      ...withDeskState(row),
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
    if (!UUID_PATTERN.test(String(id))) return error(res, 'Alert id must be a valid UUID', 400);
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

    // The person who raised it learns that the desk has it, not which
    // operator: operator identities are staff data.
    const view = withDeskState(alert);
    if (isOwner && !(await canActAsResponder(req))) {
      delete view.acknowledged_by;
      delete view.resolved_by;
    }

    return success(res, {
      alert: {
        ...view,
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
    if (!UUID_PATTERN.test(String(id))) return error(res, 'Alert id must be a valid UUID', 400);

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

    // Only an open alert is closed, so two presses at once close it, and tell
    // the trusted contacts, exactly once.
    const result = await query(
      `UPDATE emergency_alerts SET status = 'resolved', resolved_at = NOW(), resolved_by = $2
       WHERE id = $1 AND status = 'active' RETURNING *`,
      [id, req.user.id]
    );
    if (result.rowCount === 0) {
      const latest = await query('SELECT * FROM emergency_alerts WHERE id = $1', [id]);
      if (latest.rows.length === 0) return notFound(res, 'Emergency alert not found');
      return success(res, { alert: latest.rows[0] }, 'Emergency already resolved');
    }

    const alert = result.rows[0];
    // Never throws: the alert is resolved whether or not the contacts hear it.
    await notifyContactsResolved(alert, { bySender: isOwner });

    return success(res, { alert }, 'Emergency resolved');
  } catch (err) {
    console.error('Resolve emergency error:', err);
    return error(res, 'Failed to resolve emergency', 500);
  }
};

/**
 * The sender's phone reports where they are now, while their alert is open,
 * for the trusted contacts following it. Only the person who raised the alert
 * may move it; anyone else is told it does not exist. A resolved alert is
 * refused with 409, which tells the phone to stop sending.
 */
const updateAlertLocation = async (req, res) => {
  const { id } = req.params;
  try {
    if (!UUID_PATTERN.test(String(id))) return error(res, 'Alert id must be a valid UUID', 400);

    const lat = parseFloat(req.body && req.body.latitude);
    const lng = parseFloat(req.body && req.body.longitude);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 ||
        !Number.isFinite(lng) || Math.abs(lng) > 180) {
      return error(res, 'Latitude and longitude must be a valid coordinate', 400);
    }

    const updated = await query(
      `UPDATE emergency_alerts
          SET live_latitude = $3, live_longitude = $4, live_located_at = NOW()
        WHERE id = $1 AND user_id = $2 AND status = 'active'
        RETURNING id, status, live_located_at`,
      [id, req.user.id, lat, lng]
    );
    if (updated.rowCount === 1) {
      const row = updated.rows[0];
      return success(res, { alert: { id: row.id, status: row.status, live_located_at: row.live_located_at } }, 'Location updated');
    }

    const existing = await query(
      'SELECT id, status FROM emergency_alerts WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (existing.rows.length === 0) return notFound(res, 'Emergency alert not found');
    return conflict(res, 'This emergency is already resolved', { id: existing.rows[0].id, status: existing.rows[0].status });
  } catch (err) {
    console.error(`Update emergency location error (alert ${id}):`, err.message);
    return error(res, 'Failed to update the emergency location', 500);
  }
};

/** One alert with the operator names the desk shows. */
const loadDeskAlert = async (id) => {
  const result = await query(
    `SELECT a.id, a.user_id, a.type, a.status, a.created_at, a.resolved_at,
            a.acknowledged_at, a.acknowledged_by, op.name AS acknowledged_by_name,
            a.resolved_by, rb.name AS resolved_by_name
       FROM emergency_alerts a
       LEFT JOIN users op ON op.id = a.acknowledged_by
       LEFT JOIN users rb ON rb.id = a.resolved_by
      WHERE a.id = $1`,
    [id]
  );
  return result.rows[0] ? withDeskState(result.rows[0]) : null;
};

/**
 * Tells the person who raised the alert that the desk has it. Like
 * notifyResponders, the row names no operator and carries no location.
 * Never throws.
 */
const notifyReporterAcknowledged = async (alert) => {
  const written = await notify([alert.user_id], {
    type: 'emergency',
    category: 'emergency',
    title: 'Your emergency has been seen',
    message: 'The CaribWayz emergency desk has your alert and is arranging help. If you are in danger, call your local emergency number now.',
    reference_id: alert.id,
  });
  return written > 0;
};

const sameUser = (a, b) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();

/**
 * An operator takes an alert. Gated by requireResponder.
 *
 * The UPDATE only matches an open, untaken alert, so when two operators press
 * at once exactly one wins; the other gets 409 naming who has it. Pressing
 * again on an alert you already hold is not an error.
 */
const acknowledgeEmergency = async (req, res) => {
  const { id } = req.params;
  try {
    if (!UUID_PATTERN.test(String(id))) return error(res, 'Alert id must be a valid UUID', 400);

    const taken = await query(
      `UPDATE emergency_alerts
          SET acknowledged_at = NOW(), acknowledged_by = $2
        WHERE id = $1 AND status = 'active' AND acknowledged_at IS NULL
        RETURNING id`,
      [id, req.user.id]
    );

    const alert = await loadDeskAlert(id);
    if (!alert) return notFound(res, 'Emergency alert not found');

    if (taken.rowCount === 1) {
      const reporterNotified = await notifyReporterAcknowledged(alert);
      return success(res, { alert, reporter_notified: reporterNotified }, 'You have taken this emergency');
    }
    if (alert.status === 'resolved') {
      return conflict(res, 'This emergency is already resolved', alert);
    }
    if (sameUser(alert.acknowledged_by, req.user.id)) {
      return success(res, { alert, reporter_notified: null }, 'You already have this emergency');
    }
    return conflict(res, `${alert.acknowledged_by_name} has already taken this emergency`, alert);
  } catch (err) {
    console.error(`Acknowledge emergency error (alert ${id}):`, err);
    return error(res, 'Failed to acknowledge emergency', 500);
  }
};

/**
 * Hands a taken alert back to the queue, e.g. at the end of a shift. Only the
 * operator who holds it, or an administrator, may do so.
 */
const releaseEmergency = async (req, res) => {
  const { id } = req.params;
  try {
    if (!UUID_PATTERN.test(String(id))) return error(res, 'Alert id must be a valid UUID', 400);

    const released = await query(
      `UPDATE emergency_alerts
          SET acknowledged_at = NULL, acknowledged_by = NULL
        WHERE id = $1 AND status = 'active' AND acknowledged_at IS NOT NULL
          AND ($3::boolean OR acknowledged_by = $2)
        RETURNING id`,
      [id, req.user.id, req.user.role === 'admin']
    );

    const alert = await loadDeskAlert(id);
    if (!alert) return notFound(res, 'Emergency alert not found');
    if (released.rowCount === 1) return success(res, { alert }, 'Emergency returned to the queue');
    if (alert.status === 'resolved') return conflict(res, 'This emergency is already resolved', alert);
    if (!alert.acknowledged_at) return success(res, { alert }, 'Emergency is already in the queue');
    return forbidden(res, 'Only the operator who took this emergency, or an administrator, can return it');
  } catch (err) {
    console.error(`Release emergency error (alert ${id}):`, err);
    return error(res, 'Failed to return emergency to the queue', 500);
  }
};

module.exports = {
  triggerEmergency,
  listEmergencies,
  getEmergencyStatus,
  resolveEmergency,
  acknowledgeEmergency,
  releaseEmergency,
  updateAlertLocation,
  withDeskState,
  EMERGENCY_TYPES,
};
