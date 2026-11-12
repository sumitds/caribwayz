const db = require('../config/db');
const notificationService = require('./notificationService');
const { contactE164 } = require('../utils/phone');
const { notBlockedBetween } = require('./blockService');
const { displayName } = require('../utils/displayName');

/**
 * An emergency, seen by the sender's trusted contacts who use CaribWayz
 * (table emergency_alert_contacts, migration 030).
 *
 * A trusted contact is a phone number (users.emergency_contacts). It reaches an
 * account only through users.verified_phone, the number Firebase confirmed at
 * that account's phone sign-in; users.phone is typed by the person and proves
 * nothing. The SMS the sender's own phone opens is unchanged: it still goes to
 * every number, with or without the app.
 *
 * Phone numbers and coordinates are never logged here.
 */

/**
 * users.verified_phone as digits only, the expression migration 030 indexes.
 * Used to narrow the candidates in SQL; whether a candidate really is the
 * contact is decided on the full E.164 number (contactE164).
 */
const VERIFIED_DIGITS = "regexp_replace(u.verified_phone, '[^0-9]', '', 'g')";

/** The E.164 numbers among [phones], once each. */
const e164Set = (phones) => new Set(
  (Array.isArray(phones) ? phones : []).map(contactE164).filter((phone) => phone !== null)
);

/**
 * The digit strings a verified number equal to one of [numbers] can have:
 * the E.164 digits, and for a +1 number also the 10 digits without the 1, in
 * case a verified number was ever stored without its country code.
 */
const candidateDigits = (numbers) => {
  const keys = new Set();
  for (const number of numbers) {
    const digits = number.slice(1);
    keys.add(digits);
    if (digits.length === 11 && digits.startsWith('1')) keys.add(digits.slice(1));
  }
  return [...keys];
};

/**
 * Whether [verifiedPhone], an account's verified number, is one of the
 * trusted contacts [contacts], compared as E.164 numbers (contactE164).
 */
const isTrustedContactNumber = (contacts, verifiedPhone) => {
  const mine = contactE164(verifiedPhone);
  return mine !== null && e164Set(contacts).has(mine);
};

/** What a contact is called when the sender's account carries no name. */
const UNNAMED_SENDER = 'Your contact';

const sameUser = (a, b) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();

const toCoordinate = (value) => {
  if (value === null || value === undefined) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
};

const toIso = (value) => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * One alert as a trusted contact sees it.
 *
 * While it is active: where the sender is (the last position their phone
 * sent, or where they raised it) and when that was. Once it is resolved:
 * no position at all, only when the last one was taken, and whether the
 * sender closed it themselves.
 */
const contactAlertView = (row) => {
  const active = row.status === 'active';
  const liveLat = toCoordinate(row.live_latitude);
  const liveLng = toCoordinate(row.live_longitude);
  const hasLive = liveLat !== null && liveLng !== null && row.live_located_at != null;
  const lastLocationAt = toIso(hasLive ? row.live_located_at : row.created_at);

  let location = null;
  if (active) {
    const latitude = hasLive ? liveLat : toCoordinate(row.latitude);
    const longitude = hasLive ? liveLng : toCoordinate(row.longitude);
    if (latitude !== null && longitude !== null) {
      location = { latitude, longitude, updated_at: lastLocationAt };
    }
  }

  return {
    id: row.id,
    type: row.type,
    status: active ? 'active' : 'resolved',
    created_at: toIso(row.created_at),
    resolved_at: active ? null : toIso(row.resolved_at),
    resolved_by_sender: !active && sameUser(row.resolved_by, row.user_id),
    sender: {
      name: displayName(row.sender_name, UNNAMED_SENDER),
      phone: typeof row.sender_phone === 'string' && row.sender_phone.trim() !== '' ? row.sender_phone.trim() : null,
    },
    location,
    last_location_at: lastLocationAt,
  };
};

/**
 * @param {object} deps
 * @param {(text: string, params?: any[]) => Promise<{rows: any[], rowCount: number}>} deps.query
 * @param {(userIds: string[], payload: object) => Promise<number>} deps.notify
 *   services/notificationService.js notify: never throws, -1 on failure.
 */
const buildContactAlertService = ({ query, notify }) => {
  /**
   * The accounts [senderId]'s trusted contact numbers [phones] belong to.
   *
   * Both sides are compared as E.164 numbers (contactE164): a contact saved
   * as "876-555-0199" is the account verified as "+18765550199", while
   * "+5012220000" (Belize) is not "5012220000" (a US area code). A contact
   * with no country code to go on, such as a 7-digit local number, matches
   * nobody; the SMS from the sender's phone still reaches it.
   *
   * A number matches the one active account whose verified phone is the same
   * number. The sender is never their own contact. A number two accounts
   * share is skipped, not sent to both: which of them owns it cannot be told,
   * and the wrong one would see where the sender is. A blocked pair (either
   * way) is skipped too.
   *
   * Throws on a database error. Returns { recipients, ambiguous, blocked }.
   */
  const findContactAccounts = async (senderId, phones) => {
    const wanted = e164Set(phones);
    if (wanted.size === 0) return { recipients: [], ambiguous: 0, blocked: 0 };

    const result = await query(
      `SELECT u.id, u.verified_phone,
              ${notBlockedBetween('u.id', '$2')} AS reachable
         FROM users u
        WHERE u.verified_phone IS NOT NULL
          AND u.status = 'active'
          AND u.id <> $2
          AND ${VERIFIED_DIGITS} = ANY($1::text[])`,
      [candidateDigits(wanted), senderId]
    );

    const byKey = new Map();
    for (const row of result.rows) {
      const number = contactE164(row.verified_phone);
      if (number === null || !wanted.has(number)) continue;
      const list = byKey.get(number) || [];
      list.push(row);
      byKey.set(number, list);
    }

    const recipients = [];
    let ambiguous = 0;
    let blocked = 0;
    for (const rows of byKey.values()) {
      if (rows.length > 1) {
        ambiguous += 1;
        continue;
      }
      if (rows[0].reachable !== true) {
        blocked += 1;
        continue;
      }
      recipients.push(String(rows[0].id));
    }
    return { recipients: [...new Set(recipients)], ambiguous, blocked };
  };

  /**
   * Tells the sender's trusted contacts who use CaribWayz that [alert] was
   * raised, and records them as the only accounts that may open it.
   *
   * Like the desk's notification, the row and the push carry no position:
   * the contact opens the alert, where access is checked at read time.
   *
   * Never throws: a failure here must not fail the alert. Returns the number
   * of contacts notified, or -1 when it could not be done.
   */
  const notifyContactsOfAlert = async (alert) => {
    let senderName;
    let recipients;
    try {
      const sender = (await query(
        'SELECT name, emergency_contacts FROM users WHERE id = $1',
        [alert.user_id]
      )).rows[0];
      if (!sender) return 0;
      senderName = displayName(sender.name, UNNAMED_SENDER);

      const found = await findContactAccounts(alert.user_id, sender.emergency_contacts);
      if (found.ambiguous > 0) {
        console.warn(
          `Alert ${alert.id}: ${found.ambiguous} trusted contact number(s) match more than one account and were not notified in the app`
        );
      }
      recipients = found.recipients;
      if (recipients.length === 0) return 0;

      // Recorded before anyone is told, so a contact who opens the push at
      // once is already allowed to see it.
      await query(
        `INSERT INTO emergency_alert_contacts (alert_id, contact_user_id)
         SELECT $1, u.id FROM users u WHERE u.id = ANY($2::uuid[])
         ON CONFLICT DO NOTHING`,
        [alert.id, recipients]
      );
    } catch (err) {
      console.error(`Trusted contact notification failed for alert ${alert && alert.id}:`, err.message);
      return -1;
    }

    return notify(recipients, {
      type: 'emergency',
      category: 'emergency',
      title: `EMERGENCY: ${senderName} needs help`,
      message: `${senderName} raised an emergency in CaribWayz and has you as a trusted contact. Open the alert to see where they are. If they may be in danger, call your local emergency number.`,
      reference_id: alert.id,
      data: { kind: 'contact_alert' },
    });
  };

  /**
   * Tells the contacts of [alert], just resolved, that it is over and their
   * view of the sender's position has stopped. [bySender] is whether the
   * sender closed it themselves rather than the emergency desk.
   *
   * Never throws. Returns the number notified, or -1 on failure.
   */
  const notifyContactsResolved = async (alert, { bySender }) => {
    let senderName;
    let recipients;
    try {
      const result = await query(
        `SELECT c.contact_user_id, s.name AS sender_name
           FROM emergency_alert_contacts c
           JOIN users s ON s.id = $2
          WHERE c.alert_id = $1
            AND ${notBlockedBetween('c.contact_user_id', '$2')}`,
        [alert.id, alert.user_id]
      );
      if (result.rows.length === 0) return 0;
      senderName = displayName(result.rows[0].sender_name, UNNAMED_SENDER);
      recipients = result.rows.map((row) => String(row.contact_user_id));
    } catch (err) {
      console.error(`Trusted contact resolve notification failed for alert ${alert && alert.id}:`, err.message);
      return -1;
    }

    return notify(recipients, bySender
      ? {
          type: 'emergency',
          category: 'emergency',
          title: `${senderName} is safe`,
          message: `${senderName} marked themselves safe and cancelled the emergency alert. Their location is no longer shared with you.`,
          reference_id: alert.id,
          data: { kind: 'contact_alert_resolved' },
        }
      : {
          type: 'emergency',
          category: 'emergency',
          title: `${senderName}'s emergency was closed`,
          message: `The CaribWayz emergency desk closed ${senderName}'s emergency alert. Their location is no longer shared with you.`,
          reference_id: alert.id,
          data: { kind: 'contact_alert_resolved' },
        });
  };

  /**
   * Remembers [phone], just confirmed by Firebase, as [userId]'s verified
   * number, in E.164 (Firebase sends it so; it is normalised all the same).
   * Any other account holding the same number loses it: the number now
   * belongs to whoever proved it last.
   *
   * Throws on a database error; the caller decides what a failure means.
   * Returns false, without writing, for a value that is not a phone number.
   */
  const recordVerifiedPhone = async (userId, phone) => {
    const stored = contactE164(phone);
    // users.verified_phone is VARCHAR(20); E.164 is at most 16 characters.
    if (stored === null || stored.length > 20) return false;
    await query(
      `WITH released AS (
         UPDATE users u SET verified_phone = NULL
          WHERE u.verified_phone IS NOT NULL
            AND u.id <> $1
            AND ${VERIFIED_DIGITS} = ANY($3::text[])
       )
       UPDATE users SET verified_phone = $2 WHERE id = $1`,
      [userId, stored, candidateDigits([stored])]
    );
    return true;
  };

  return { findContactAccounts, notifyContactsOfAlert, notifyContactsResolved, recordVerifiedPhone };
};

const { findContactAccounts, notifyContactsOfAlert, notifyContactsResolved, recordVerifiedPhone } =
  buildContactAlertService({
    query: (text, params) => db.query(text, params),
    notify: (userIds, payload) => notificationService.notify(userIds, payload),
  });

module.exports = {
  buildContactAlertService,
  contactAlertView,
  findContactAccounts,
  isTrustedContactNumber,
  notifyContactsOfAlert,
  notifyContactsResolved,
  recordVerifiedPhone,
  UNNAMED_SENDER,
};
