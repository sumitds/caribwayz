const { query } = require('../config/db');
const { haversineDistance, estimateETA } = require('../utils/haversine');
const { resolveResponderAccess } = require('../middleware/auth');
const { success, created, error, notFound, forbidden } = require('../utils/response');
const { displayName } = require('../utils/displayName');
const { notify } = require('../services/notificationService');
const { notifyContactsOfAlert, notifyContactsClosed } = require('../services/contactAlertService');
const {
  DESK_STATUS, deskStatusOf, isOpenDeskStatus, closedAtOf, alreadyClosedMessage, evaluateTransition,
} = require('../services/emergencyStatus');

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

/** The feed's status filter: open alerts, or closed ones ('resolved' is the older name for closed). */
const LIST_STATUSES = ['active', 'closed', 'resolved'];

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
 * Adds desk_status (services/emergencyStatus.js), closed_at, and readable
 * operator names.
 *
 * desk_status is the Emergency Desk Disclaimer's status: pending,
 * acknowledged, addressed or cancelled (resolved only on alerts the desk
 * closed before migration 033). status stays 'active' or 'resolved', the
 * open/closed value the app 1.0.11 reads. acknowledged_at, not
 * acknowledged_by, says the alert was taken: a deleted operator account
 * leaves it taken, by "a former operator".
 */
const withDeskStatus = (row) => {
  const deskStatus = deskStatusOf(row);
  const out = { ...row, desk_status: deskStatus, closed_at: closedAtOf(row) };
  if ('acknowledged_by_name' in row) {
    out.acknowledged_by_name = row.acknowledged_at
      ? displayName(row.acknowledged_by_name, row.acknowledged_by ? 'An operator' : 'A former operator')
      : null;
  }
  if ('addressed_by_name' in row) {
    out.addressed_by_name = row.addressed_at
      ? displayName(row.addressed_by_name, row.addressed_by ? 'An operator' : 'A former operator')
      : null;
  }
  if ('resolved_by_name' in row) {
    out.resolved_by_name = row.resolved_by ? displayName(row.resolved_by_name, 'An operator') : null;
  }
  return out;
};

/**
 * [alert] as the person who raised it sees it: the desk status and its times,
 * not which operator did what. Operator identities are staff data.
 */
const OPERATOR_FIELDS = [
  'acknowledged_by', 'acknowledged_by_name',
  'addressed_by', 'addressed_by_name',
  'resolved_by', 'resolved_by_name',
];
const ownerView = (alert) => {
  const out = { ...alert };
  for (const field of OPERATOR_FIELDS) delete out[field];
  return out;
};

/**
 * The responder feed: emergency alerts, nearest first.
 *
 * Gated by requireResponder. These rows are live locations of people in
 * trouble, so this must never be readable by an ordinary driver account.
 *
 * Query parameters:
 *   lat, lng  optional; when both are given, results are ordered by distance
 *             from that point and annotated with distance_km and eta_minutes
 *   radius    optional km limit; ignored unless lat and lng are both present
 *   status    active (default): open alerts, desk_status pending or
 *             acknowledged. closed: addressed, cancelled and resolved alerts,
 *             admin-only, because that set is a historical archive of where
 *             people have been. resolved is accepted as the older name for
 *             closed; each row's desk_status says how it was closed.
 *   limit     1-200, default 100, applied after the distance sort
 */
const listEmergencies = async (req, res) => {
  try {
    const { lat, lng, radius, status = 'active' } = req.query;

    if (!LIST_STATUSES.includes(status)) {
      return error(
        res,
        `Invalid status. Must be one of: ${LIST_STATUSES.join(', ')}`,
        400
      );
    }

    const wantsOpen = status === 'active';
    if (!wantsOpen && !isAdminAccess(req.responderAccess)) {
      return forbidden(res, 'Only an administrator can list closed alerts');
    }

    const parsedLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 200)
      : 100;

    // reporter_emergency_contact is deliberately absent. It belongs to a third
    // party who has not raised an emergency, the responder does not need it to
    // attend the scene, and the client never read it.
    const result = await query(
      `SELECT a.id, a.type, a.latitude, a.longitude, a.description, a.status, a.desk_status,
              a.created_at, a.resolved_at,
              a.acknowledged_at, a.acknowledged_by, op.name AS acknowledged_by_name,
              a.addressed_at, a.addressed_by, ad.name AS addressed_by_name,
              a.cancelled_at,
              a.resolved_by, rb.name AS resolved_by_name,
              u.id   AS reporter_id,
              u.name AS reporter_name,
              u.phone AS reporter_phone
         FROM emergency_alerts a
         JOIN users u ON u.id = a.user_id
         LEFT JOIN users op ON op.id = a.acknowledged_by
         LEFT JOIN users ad ON ad.id = a.addressed_by
         LEFT JOIN users rb ON rb.id = a.resolved_by
        WHERE a.status = $1
        ORDER BY a.created_at DESC
        LIMIT $2`,
      [wantsOpen ? 'active' : 'resolved', MAX_CANDIDATE_ALERTS]
    );

    let alerts = result.rows.map((row) => ({
      ...withDeskStatus(row),
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
 * The requesting user's responder access, or null when they have none.
 *
 * Delegates to the same check the feed middleware uses, so a change to who
 * counts as a responder cannot apply to the list endpoint while leaving the
 * per-id endpoints open.
 */
const responderAccessOf = async (req) => {
  try {
    const access = await resolveResponderAccess(req.user.id);
    return access.allowed === true ? access : null;
  } catch (err) {
    console.error('Responder check error:', err);
    // Fail closed.
    return null;
  }
};

/** Whether the requesting user may act on an alert they do not own. */
const canActAsResponder = async (req) => (await responderAccessOf(req)) !== null;

/**
 * Whether [access] (resolveResponderAccess, as requireResponder attaches it
 * to req.responderAccess) is an administrator's. The role is the one stored
 * now, never the token's claim, which outlives a removed role.
 */
const isAdminAccess = (access) => Boolean(access && access.allowed === true && access.role === 'admin');

const sameUser = (a, b) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();

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
    const isResponder = await canActAsResponder(req);
    if (!isOwner && !isResponder) {
      return forbidden(res, 'Not authorized to view this alert');
    }

    // The person who raised it learns the desk status, not which operator.
    const view = isResponder ? withDeskStatus(alert) : ownerView(withDeskStatus(alert));

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

/**
 * The sender's phone reports where they are now, while their alert is open,
 * for the trusted contacts following it. Only the person who raised the alert
 * may move it; anyone else is told it does not exist. A closed alert
 * (addressed, cancelled or resolved) is refused with 409, which tells the
 * phone to stop sending.
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
        RETURNING id, status, desk_status, live_located_at`,
      [id, req.user.id, lat, lng]
    );
    if (updated.rowCount === 1) {
      const row = updated.rows[0];
      return success(res, {
        alert: { id: row.id, status: row.status, desk_status: row.desk_status, live_located_at: row.live_located_at },
      }, 'Location updated');
    }

    const existing = await query(
      'SELECT id, status, desk_status FROM emergency_alerts WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (existing.rows.length === 0) return notFound(res, 'Emergency alert not found');
    const row = existing.rows[0];
    return conflict(res, alreadyClosedMessage(row.desk_status), { id: row.id, status: row.status, desk_status: row.desk_status });
  } catch (err) {
    console.error(`Update emergency location error (alert ${id}):`, err.message);
    return error(res, 'Failed to update the emergency location', 500);
  }
};

/** One alert with the operator names the desk shows. */
const loadDeskAlert = async (id) => {
  const result = await query(
    `SELECT a.id, a.user_id, a.type, a.status, a.desk_status, a.created_at,
            a.acknowledged_at, a.acknowledged_by, op.name AS acknowledged_by_name,
            a.addressed_at, a.addressed_by, ad.name AS addressed_by_name,
            a.cancelled_at,
            a.resolved_at, a.resolved_by, rb.name AS resolved_by_name
       FROM emergency_alerts a
       LEFT JOIN users op ON op.id = a.acknowledged_by
       LEFT JOIN users ad ON ad.id = a.addressed_by
       LEFT JOIN users rb ON rb.id = a.resolved_by
      WHERE a.id = $1`,
    [id]
  );
  return result.rows[0] ? withDeskStatus(result.rows[0]) : null;
};

/**
 * What the person who raised an alert is told when the desk changes its
 * status. Each names the status in the disclaimer's word, and says what the
 * status does not mean (disclaimer 5.4, 5.5, 5.9): an acknowledgment is not a
 * dispatch, and addressed is not "help has arrived" or "it is over".
 */
const REPORTER_NOTICES = Object.freeze({
  [DESK_STATUS.ACKNOWLEDGED]: Object.freeze({
    title: 'Emergency status: Acknowledged',
    message: 'The CaribWayz Emergency Desk has acknowledged your alert. This does not mean that an emergency responder has been dispatched. If you are in danger, call your local emergency number now (in Jamaica: 119 police, 110 fire and ambulance).',
  }),
  [DESK_STATUS.ADDRESSED]: Object.freeze({
    title: 'Emergency status: Addressed',
    message: 'The CaribWayz Emergency Desk has marked your alert as addressed. This does not confirm that help has arrived or that the emergency is over. If you still need help, call your local emergency number now (in Jamaica: 119 police, 110 fire and ambulance).',
  }),
});

/**
 * Tells the person who raised [alert] its new [deskStatus]. Like
 * notifyResponders, the row names no operator and carries no location.
 * Never throws. Returns whether the notification was written.
 */
const notifyReporter = async (alert, deskStatus) => {
  const notice = REPORTER_NOTICES[deskStatus];
  if (!notice) {
    console.error(`Reporter notification for alert ${alert && alert.id}: no notice for status ${deskStatus}`);
    return false;
  }
  const written = await notify([alert.user_id], {
    type: 'emergency',
    category: 'emergency',
    title: notice.title,
    message: notice.message,
    reference_id: alert.id,
    data: { desk_status: deskStatus },
  });
  return written > 0;
};

/**
 * The one statement each desk action runs. Each only matches an alert in a
 * status the action may start from (services/emergencyStatus.js ACTIONS),
 * with the same "who may" rule evaluateTransition applies, so two presses at
 * once change the alert, and tell people, exactly once. status, the legacy
 * open/closed flag, moves with desk_status (constraint in migration 033).
 */
const DESK_UPDATES = Object.freeze({
  acknowledge: {
    sql: `UPDATE emergency_alerts
             SET desk_status = 'acknowledged', acknowledged_at = NOW(), acknowledged_by = $2
           WHERE id = $1 AND desk_status = 'pending'
           RETURNING id`,
    withAdminFlag: false,
  },
  release: {
    sql: `UPDATE emergency_alerts
             SET desk_status = 'pending', acknowledged_at = NULL, acknowledged_by = NULL
           WHERE id = $1 AND desk_status = 'acknowledged'
             AND ($3::boolean OR acknowledged_by = $2)
           RETURNING id`,
    withAdminFlag: true,
  },
  address: {
    sql: `UPDATE emergency_alerts
             SET desk_status = 'addressed', status = 'resolved', addressed_at = NOW(), addressed_by = $2
           WHERE id = $1
             AND (desk_status = 'pending'
                  OR (desk_status = 'acknowledged' AND ($3::boolean OR acknowledged_by = $2)))
           RETURNING id`,
    withAdminFlag: true,
  },
  cancel: {
    sql: `UPDATE emergency_alerts
             SET desk_status = 'cancelled', status = 'resolved', cancelled_at = NOW(), cancelled_by = $2
           WHERE id = $1 AND user_id = $2 AND desk_status IN ('pending', 'acknowledged')
           RETURNING id`,
    withAdminFlag: false,
  },
});

/**
 * Who is acting, as evaluateTransition reads it. [access] is the
 * resolveResponderAccess result read for this request, or null for someone
 * acting only as the person who raised the alert.
 */
const actorFor = (req, access) => ({
  id: req.user.id,
  isAdmin: isAdminAccess(access),
  isResponder: Boolean(access && access.allowed === true),
});

/**
 * Runs desk [action] on alert [id] for [actor].
 *
 * Returns { kind, alert, message }: kind is 'applied', 'unchanged',
 * 'forbidden', 'conflict' or 'not_found'. When the statement changed
 * nothing, the alert is read again and evaluateTransition says why, so the
 * answer reflects the alert as it is now. Throws on a database error.
 */
const runDeskAction = async (action, id, actor) => {
  const update = DESK_UPDATES[action];
  // Every action but cancel is the desk's. The routes are gated by
  // requireResponder; this keeps the statement from running if one is not.
  if (action !== 'cancel' && !actor.isResponder && !actor.isAdmin) {
    return { kind: 'forbidden', message: 'Responder access required' };
  }
  const params = update.withAdminFlag ? [id, actor.id, actor.isAdmin === true] : [id, actor.id];
  const changed = await query(update.sql, params);

  const alert = await loadDeskAlert(id);
  if (!alert) return { kind: 'not_found' };
  if (changed.rowCount === 1) return { kind: 'applied', alert };

  const verdict = evaluateTransition(action, alert, actor);
  if (verdict.outcome === 'apply') {
    // The alert was in another status when the statement ran and has moved
    // back since: another operator acted at the same instant.
    return { kind: 'conflict', alert, message: 'This emergency changed while you were updating it. Refresh and try again.' };
  }
  return { kind: verdict.outcome, alert, message: verdict.message };
};

/** Answers a desk action that did not apply. */
const sendNotApplied = (res, result, unchangedData = {}) => {
  switch (result.kind) {
    case 'not_found':
      return notFound(res, 'Emergency alert not found');
    case 'unchanged':
      return success(res, { alert: result.alert, ...unchangedData }, result.message);
    case 'forbidden':
      return forbidden(res, result.message);
    default:
      return conflict(res, result.message, result.alert);
  }
};

/**
 * An operator takes an alert: pending -> acknowledged. Gated by
 * requireResponder.
 *
 * The UPDATE only matches a pending alert, so when two operators press at
 * once exactly one wins; the other gets 409 naming who has it. Pressing
 * again on an alert you already hold is not an error.
 */
const acknowledgeEmergency = async (req, res) => {
  const { id } = req.params;
  try {
    if (!UUID_PATTERN.test(String(id))) return error(res, 'Alert id must be a valid UUID', 400);

    const result = await runDeskAction('acknowledge', id, actorFor(req, req.responderAccess));
    if (result.kind === 'applied') {
      const reporterNotified = await notifyReporter(result.alert, DESK_STATUS.ACKNOWLEDGED);
      return success(res, { alert: result.alert, reporter_notified: reporterNotified }, 'You have taken this emergency');
    }
    return sendNotApplied(res, result, { reporter_notified: null });
  } catch (err) {
    console.error(`Acknowledge emergency error (alert ${id}):`, err);
    return error(res, 'Failed to acknowledge emergency', 500);
  }
};

/**
 * Hands a taken alert back to the queue, e.g. at the end of a shift:
 * acknowledged -> pending. Only the operator who holds it, or an
 * administrator, may do so.
 */
const releaseEmergency = async (req, res) => {
  const { id } = req.params;
  try {
    if (!UUID_PATTERN.test(String(id))) return error(res, 'Alert id must be a valid UUID', 400);

    const result = await runDeskAction('release', id, actorFor(req, req.responderAccess));
    if (result.kind === 'applied') return success(res, { alert: result.alert }, 'Emergency returned to the queue');
    return sendNotApplied(res, result);
  } catch (err) {
    console.error(`Release emergency error (alert ${id}):`, err);
    return error(res, 'Failed to return emergency to the queue', 500);
  }
};

/**
 * The 403 a responder's POST /:id/resolve from an older client gets for an
 * alert another operator holds. That client says "Resolve", not "Addressed".
 */
const LEGACY_RESOLVE_NOT_HOLDER = 'Another operator has taken this emergency. Only that operator or an administrator can close it.';

/**
 * pending or acknowledged -> addressed, then the reporter and their trusted
 * contacts are told, each in the word Addressed. Shared by POST /:id/address
 * and a responder's POST /:id/resolve from an older client ([legacy]).
 * [access] is the responder access read for this request.
 */
const markAddressed = async (req, res, id, access, { legacy }) => {
  const result = await runDeskAction('address', id, actorFor(req, access));
  if (result.kind !== 'applied') {
    if (legacy) {
      // The app 1.0.11 treats anything but 2xx from its "Resolve" as "still
      // active". An alert already closed, whichever way, is not, so the old
      // route answers 200 with the status as it is, as the old API did.
      if (result.kind === 'conflict' && result.alert && !isOpenDeskStatus(result.alert.desk_status)) {
        return success(res, { alert: result.alert }, result.message);
      }
      if (result.kind === 'forbidden') return forbidden(res, LEGACY_RESOLVE_NOT_HOLDER);
    }
    return sendNotApplied(res, result);
  }

  // Neither throws: the alert is addressed whether or not anyone hears it.
  const [reporterNotified, contactsNotified] = await Promise.all([
    notifyReporter(result.alert, DESK_STATUS.ADDRESSED),
    notifyContactsClosed(result.alert, { deskStatus: DESK_STATUS.ADDRESSED }),
  ]);
  return success(
    res,
    { alert: result.alert, reporter_notified: reporterNotified, contacts_notified: contactsNotified },
    'Emergency marked Addressed'
  );
};

/**
 * pending or acknowledged -> cancelled, by the person who raised the alert,
 * then their trusted contacts are told. Shared by POST /:id/cancel and the
 * sender's POST /:id/resolve from an older client.
 */
const cancelOwnAlert = async (req, res, id, { legacy }) => {
  const result = await runDeskAction('cancel', id, actorFor(req, null));
  if (result.kind === 'applied') {
    // Never throws: the alert is cancelled whether or not the contacts hear it.
    const contactsNotified = await notifyContactsClosed(result.alert, { deskStatus: DESK_STATUS.CANCELLED });
    return success(res, { alert: ownerView(result.alert), contacts_notified: contactsNotified }, 'Emergency alert cancelled');
  }
  const shown = result.alert ? { ...result, alert: ownerView(result.alert) } : result;
  // The app 1.0.11 treats anything but 2xx as "could not cancel, it is still
  // open". An alert the desk has already closed is not open, so the old route
  // answers 200 with the status as it is; /cancel answers 409.
  if (legacy && shown.kind === 'conflict' && shown.alert && !isOpenDeskStatus(shown.alert.desk_status)) {
    return success(res, { alert: shown.alert }, shown.message);
  }
  return sendNotApplied(res, shown);
};

/** POST /:id/address. Gated by requireResponder. */
const addressEmergency = async (req, res) => {
  const { id } = req.params;
  try {
    if (!UUID_PATTERN.test(String(id))) return error(res, 'Alert id must be a valid UUID', 400);
    return await markAddressed(req, res, id, req.responderAccess, { legacy: false });
  } catch (err) {
    console.error(`Address emergency error (alert ${id}):`, err);
    return error(res, 'Failed to mark the emergency Addressed', 500);
  }
};

/** POST /:id/cancel. Only the person who raised the alert. */
const cancelEmergency = async (req, res) => {
  const { id } = req.params;
  try {
    if (!UUID_PATTERN.test(String(id))) return error(res, 'Alert id must be a valid UUID', 400);
    return await cancelOwnAlert(req, res, id, { legacy: false });
  } catch (err) {
    console.error(`Cancel emergency error (alert ${id}):`, err);
    return error(res, 'Failed to cancel the emergency alert', 500);
  }
};

/**
 * POST /:id/resolve, kept for the clients that still call it: the app 1.0.11
 * (the sender's "I'm safe", and a responder's "Resolve") and an admin desk
 * page loaded before this release. It never records "resolved": the sender
 * cancels their alert (Cancelled), a responder marks it Addressed. Anyone
 * else is refused. An alert already closed, whichever way, answers 200 with
 * its status as it is, as the old API answered "already resolved": the app
 * 1.0.11 reads anything else as "still active".
 */
const resolveEmergency = async (req, res) => {
  const { id } = req.params;
  try {
    if (!UUID_PATTERN.test(String(id))) return error(res, 'Alert id must be a valid UUID', 400);

    const existing = await query('SELECT user_id FROM emergency_alerts WHERE id = $1', [id]);
    if (existing.rows.length === 0) return notFound(res, 'Emergency alert not found');

    if (sameUser(existing.rows[0].user_id, req.user.id)) {
      return await cancelOwnAlert(req, res, id, { legacy: true });
    }
    const access = await responderAccessOf(req);
    if (!access) {
      return forbidden(res, 'Not authorized to resolve this alert');
    }
    return await markAddressed(req, res, id, access, { legacy: true });
  } catch (err) {
    console.error(`Resolve emergency error (alert ${id}):`, err);
    return error(res, 'Failed to resolve emergency', 500);
  }
};

module.exports = {
  triggerEmergency,
  listEmergencies,
  getEmergencyStatus,
  resolveEmergency,
  acknowledgeEmergency,
  releaseEmergency,
  addressEmergency,
  cancelEmergency,
  updateAlertLocation,
  withDeskStatus,
  ownerView,
  REPORTER_NOTICES,
  EMERGENCY_TYPES,
};
