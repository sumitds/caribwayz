const db = require('../config/db');
const firebase = require('../config/firebase');

/**
 * The one way a notification is sent: a row in the in-app notification list
 * for every recipient, and a push to their phones when FCM is configured and
 * they have not switched that kind of push off.
 *
 * The row is the record and survives the phone being off; the push is the
 * prompt to look. So a push failure is logged and never fails the request that
 * raised it, and when Firebase is not configured only the rows are written.
 */

/** Push category -> the user_preferences column that switches it, and its default. */
const CATEGORIES = Object.freeze({
  emergency: { column: 'push_emergency', fallback: true },
  group: { column: 'push_group', fallback: true },
  reports: { column: 'push_reports', fallback: true },
  app_updates: { column: 'push_app_updates', fallback: true },
  promotions: { column: 'push_promotions', fallback: false },
  weather: { column: 'push_weather', fallback: true },
});

/** Values allowed by the notifications.type CHECK constraint. */
const NOTIFICATION_TYPES = Object.freeze(['general', 'report', 'emergency', 'group', 'route', 'system']);

/** Android notification channels the app creates. Emergencies get the loud one. */
const ALERT_CHANNEL = 'caribwayz_alerts';
const GENERAL_CHANNEL = 'caribwayz_general';

/** Categories that ring on ALERT_CHANNEL: a storm warning is as urgent as an SOS. */
const ALERT_CATEGORIES = new Set(['emergency', 'weather']);

/** sendEachForMulticast accepts at most 500 tokens per call. */
const FCM_BATCH_SIZE = 500;

/** notifications.title is VARCHAR(255). */
const TITLE_MAX_LENGTH = 255;

/**
 * FCM refuses a message over 4096 bytes. The push body is only the prompt to
 * open the notification, whose row keeps the full text, so it is cut to 500
 * characters: at most 2000 bytes of UTF-8, which with a full title and the data
 * keys stays under the limit.
 */
const PUSH_BODY_MAX_LENGTH = 500;

/** FCM errors that mean the token will never work again, so it is deleted. */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/** Truncates by code point so a surrogate pair is never split in half. */
const truncate = (text, max) => {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
};

/** The push body: [message] cut to PUSH_BODY_MAX_LENGTH, ending in an ellipsis when cut. */
const pushBody = (message) => {
  const chars = Array.from(message);
  return chars.length > PUSH_BODY_MAX_LENGTH
    ? `${chars.slice(0, PUSH_BODY_MAX_LENGTH - 1).join('')}\u2026`
    : message;
};

/** Distinct, non-empty recipient ids. */
const distinctIds = (userIds) => {
  if (!Array.isArray(userIds)) return [];
  return [...new Set(userIds.filter((id) => typeof id === 'string' && id !== '').map((id) => id.toLowerCase()))];
};

/** FCM data values must all be strings. null and undefined become ''. */
const toDataPayload = (data, { type, reference_id, category }) => {
  const out = {};
  if (data && typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined || value === null) continue;
      out[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
  }
  // The three routing keys are always present and always win over [data].
  out.type = String(type);
  out.reference_id = reference_id == null ? '' : String(reference_id);
  out.category = String(category);
  return out;
};

/** The multicast message for one batch of tokens. */
const buildMessage = (tokens, { title, message, type, reference_id, data, category }) => ({
  tokens,
  notification: { title, body: pushBody(String(message)) },
  data: toDataPayload(data, { type, reference_id, category }),
  android: {
    priority: 'high',
    notification: { channelId: ALERT_CATEGORIES.has(category) ? ALERT_CHANNEL : GENERAL_CHANNEL },
  },
  apns: { payload: { aps: { sound: 'default' } } },
});

/**
 * @param {object} deps
 * @param {(text: string, params?: any[]) => Promise<{rows: any[], rowCount: number}>} deps.query
 * @param {() => any} deps.getMessaging firebase-admin messaging, or null when not configured
 */
const buildNotificationService = ({ query, getMessaging }) => {
  /**
   * Writes one notification row per recipient through [run], which is the pool
   * query or a transaction client's query. Recipients are joined against users
   * so an account deleted in the meantime is skipped instead of failing every
   * other recipient's row on the foreign key. A single uuid[] parameter keeps
   * the bound-parameter count fixed however many recipients there are.
   *
   * Throws on a database error, so a caller inside a transaction can roll back.
   * Returns the number of rows written.
   */
  const insertNotifications = async (run, userIds, { type, title, message, reference_id = null }) => {
    const recipients = distinctIds(userIds);
    if (recipients.length === 0) return 0;
    if (!NOTIFICATION_TYPES.includes(type)) {
      throw new Error(`Unknown notification type "${type}"`);
    }
    const result = await run(
      `INSERT INTO notifications (user_id, title, message, type, reference_id)
       SELECT u.id, $1, $2, $5, $3
         FROM users u
        WHERE u.id = ANY($4::uuid[])`,
      [truncate(String(title), TITLE_MAX_LENGTH), String(message), reference_id, recipients, type]
    );
    return result.rowCount || 0;
  };

  /** Deletes tokens FCM has said will never work again. Never throws. */
  const pruneTokens = async (tokens) => {
    if (tokens.length === 0) return 0;
    try {
      const result = await query('DELETE FROM device_tokens WHERE token = ANY($1::text[])', [tokens]);
      return result.rowCount || 0;
    } catch (err) {
      console.error(`Pruning ${tokens.length} dead push token(s) failed:`, err.message);
      return 0;
    }
  };

  /**
   * Pushes to every signed-in phone of [userIds] whose owner is active and has
   * the [category] switch on (a missing preferences row means the default).
   *
   * Never throws. Returns { sent, failed, pruned }, or null when push is not
   * configured or the request was unusable.
   */
  const sendPush = async (userIds, payload) => {
    const { category, title, message } = payload || {};
    const recipients = distinctIds(userIds);
    if (recipients.length === 0) return { sent: 0, failed: 0, pruned: 0 };

    const pref = CATEGORIES[category];
    if (!pref) {
      console.error(`Push skipped: unknown category "${category}" for "${title}"`);
      return null;
    }

    let messaging;
    try {
      messaging = getMessaging();
    } catch (err) {
      console.error('Push skipped: Firebase messaging could not be loaded:', err.message);
      return null;
    }
    if (!messaging) return null;

    try {
      // pref.column comes from the fixed CATEGORIES table above, never from input.
      const found = await query(
        `SELECT dt.token
           FROM device_tokens dt
           JOIN users u ON u.id = dt.user_id AND u.status = 'active'
           LEFT JOIN user_preferences p ON p.user_id = dt.user_id
          WHERE dt.user_id = ANY($1::uuid[])
            AND COALESCE(p.${pref.column}, ${pref.fallback ? 'TRUE' : 'FALSE'})`,
        [recipients]
      );
      const tokens = found.rows.map((row) => row.token);
      let sent = 0;
      let failed = 0;
      const dead = [];
      // Why tokens failed, as FCM error code -> count, so a log line says what
      // went wrong (bad credentials, sender mismatch) without naming a token.
      const reasons = new Map();

      for (let i = 0; i < tokens.length; i += FCM_BATCH_SIZE) {
        const batch = tokens.slice(i, i + FCM_BATCH_SIZE);
        try {
          const response = await messaging.sendEachForMulticast(
            buildMessage(batch, { ...payload, title: truncate(String(title), TITLE_MAX_LENGTH), message: String(message) })
          );
          sent += response.successCount;
          failed += response.failureCount;
          response.responses.forEach((r, index) => {
            if (r.success) return;
            const code = (r.error && r.error.code) || 'unknown';
            reasons.set(code, (reasons.get(code) || 0) + 1);
            if (DEAD_TOKEN_CODES.has(code)) dead.push(batch[index]);
          });
        } catch (err) {
          // A whole batch failing (credentials, network) is not the tokens'
          // fault, so nothing is pruned for it.
          failed += batch.length;
          console.error(`Push batch of ${batch.length} for "${category}" failed:`, err.message);
        }
      }

      const pruned = await pruneTokens(dead);
      if (failed > 0) {
        const why = [...reasons].map(([code, count]) => `${code} x${count}`).join(', ');
        console.warn(
          `Push "${category}": ${sent} sent, ${failed} failed, ${pruned} dead token(s) removed` +
            (why ? ` (${why})` : '')
        );
      }
      return { sent, failed, pruned };
    } catch (err) {
      console.error(`Push for "${category}" failed:`, err.message);
      return null;
    }
  };

  /**
   * Notifies [userIds]: writes their notification rows, then pushes.
   *
   * @param {string[]} userIds recipients; duplicates and blanks are ignored
   * @param {object} payload
   * @param {string} payload.type        notifications.type value
   * @param {string} payload.title
   * @param {string} payload.message
   * @param {string|null} [payload.reference_id]
   * @param {object} [payload.data]      extra FCM data keys (stringified)
   * @param {string} payload.category    a key of CATEGORIES
   *
   * Never throws. Returns the number of rows written, or -1 when writing them
   * failed (no push is sent then: a push must not point at a missing row).
   */
  const notify = async (userIds, payload) => {
    let written;
    try {
      written = await insertNotifications(query, userIds, payload || {});
    } catch (err) {
      console.error(
        `Notification "${payload && payload.title}" (${payload && payload.type}) failed:`,
        err.message
      );
      return -1;
    }
    if (written > 0) await sendPush(userIds, payload);
    return written;
  };

  return { notify, sendPush, insertNotifications };
};

const { notify, sendPush, insertNotifications } = buildNotificationService({
  query: db.query,
  getMessaging: firebase.getMessaging,
});

module.exports = {
  buildNotificationService,
  notify,
  sendPush,
  insertNotifications,
  CATEGORIES,
  NOTIFICATION_TYPES,
  ALERT_CHANNEL,
  GENERAL_CHANNEL,
  FCM_BATCH_SIZE,
  PUSH_BODY_MAX_LENGTH,
};
