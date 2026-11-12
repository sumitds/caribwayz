const { query } = require('../config/db');
const { success, error, notFound } = require('../utils/response');
const { notBlockedBetween } = require('../services/blockService');
const { contactAlertView, isTrustedContactNumber } = require('../services/contactAlertService');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long a closed alert stays in the contact's list. */
const RESOLVED_LIST_WINDOW_HOURS = 24;

/** The most alerts the contact's list returns. */
const MAX_LISTED_ALERTS = 50;

/**
 * Emergencies raised by people who have the caller as a trusted contact
 * (services/contactAlertService.js, migration 030).
 *
 * An alert is readable here only by an account recorded in
 * emergency_alert_contacts for it, and only while neither has blocked the
 * other and the reader is still one of the sender's trusted contacts: the
 * reader's verified number is still theirs and still on the sender's list
 * (compared as E.164, as when the alert was raised). Someone the sender has
 * since taken off the list, or who has lost the number to another account,
 * stops seeing it. Everyone else, the sender included, gets 404: the sender
 * reads their own alert at GET /emergency/:id, and nobody else may learn that
 * it exists.
 *
 * The number a contact can call is the sender's verified number only. The
 * phone typed on a profile proves nothing and may be anyone's, so with no
 * verified number there is nothing to call and the app says so.
 */

/** Whether the reader of [row] is still on its sender's trusted contacts. */
const stillAContact = (row) => isTrustedContactNumber(row.sender_contacts, row.reader_phone);

/**
 * @param {object} deps
 * @param {(text: string, params?: any[]) => Promise<{rows: any[], rowCount: number}>} deps.query
 */
const buildContactAlertHandlers = ({ query: run }) => {
  /** GET /emergency/contact-alerts/:id */
  const getContactAlert = async (req, res) => {
    const { id } = req.params;
    try {
      if (!UUID_PATTERN.test(String(id))) return error(res, 'Alert id must be a valid UUID', 400);

      const result = await run(
        `SELECT a.id, a.user_id, a.type, a.status, a.created_at, a.resolved_at, a.resolved_by,
                a.latitude, a.longitude, a.live_latitude, a.live_longitude, a.live_located_at,
                s.name AS sender_name, s.verified_phone AS sender_phone,
                s.emergency_contacts AS sender_contacts, r.verified_phone AS reader_phone
           FROM emergency_alert_contacts c
           JOIN emergency_alerts a ON a.id = c.alert_id
           JOIN users s ON s.id = a.user_id
           JOIN users r ON r.id = c.contact_user_id
          WHERE c.alert_id = $1
            AND c.contact_user_id = $2
            AND ${notBlockedBetween('a.user_id', '$2')}`,
        [id, req.user.id]
      );
      if (result.rows.length === 0 || !stillAContact(result.rows[0])) {
        return notFound(res, 'Emergency alert not found');
      }

      return success(res, { alert: contactAlertView(result.rows[0]) });
    } catch (err) {
      console.error(`Get contact alert error (alert ${id}):`, err.message);
      return error(res, 'Failed to fetch the emergency alert', 500);
    }
  };

  /**
   * GET /emergency/contact-alerts
   *
   * The caller's open contact alerts, and those closed in the last day, newest
   * first. No positions: the list only leads to the alert.
   */
  const listContactAlerts = async (req, res) => {
    try {
      const result = await run(
        `SELECT a.id, a.user_id, a.type, a.status, a.created_at, a.resolved_at, a.resolved_by,
                a.live_latitude, a.live_longitude, a.live_located_at,
                s.name AS sender_name, s.verified_phone AS sender_phone,
                s.emergency_contacts AS sender_contacts, r.verified_phone AS reader_phone
           FROM emergency_alert_contacts c
           JOIN emergency_alerts a ON a.id = c.alert_id
           JOIN users s ON s.id = a.user_id
           JOIN users r ON r.id = c.contact_user_id
          WHERE c.contact_user_id = $1
            AND ${notBlockedBetween('a.user_id', '$1')}
            AND (a.status = 'active' OR a.resolved_at > NOW() - make_interval(hours => $2))
          ORDER BY (a.status = 'active') DESC, a.created_at DESC
          LIMIT $3`,
        [req.user.id, RESOLVED_LIST_WINDOW_HOURS, MAX_LISTED_ALERTS]
      );

      const alerts = result.rows.filter(stillAContact).map((row) => {
        const { location, ...summary } = contactAlertView(row);
        return summary;
      });
      return success(res, { alerts, count: alerts.length });
    } catch (err) {
      console.error('List contact alerts error:', err.message);
      return error(res, 'Failed to fetch emergency alerts', 500);
    }
  };

  return { getContactAlert, listContactAlerts };
};

const { getContactAlert, listContactAlerts } = buildContactAlertHandlers({ query });

module.exports = {
  buildContactAlertHandlers,
  getContactAlert,
  listContactAlerts,
  RESOLVED_LIST_WINDOW_HOURS,
  MAX_LISTED_ALERTS,
};
