const db = require('../config/db');
const { success, error, notFound } = require('../utils/response');
const { MAX_EMERGENCY_CONTACTS, readContactList } = require('../utils/phone');

/**
 * The trusted contacts texted when the person sends an SOS (users.
 * emergency_contacts, migration 023).
 *
 * The texts go from the person's own phone, so the server only keeps the list.
 * users.emergency_contact is kept equal to the first entry, because sign-up,
 * the profile and older app versions still use that one field.
 */

/** Postgres check_violation: the database refused the list (the cap in migration 023). */
const CHECK_VIOLATION = '23514';

const contactsBody = (row) => ({
  emergency_contacts: row.emergency_contacts || [],
  emergency_contact: row.emergency_contact || null,
  max_contacts: MAX_EMERGENCY_CONTACTS,
});

/**
 * @param {object} deps
 * @param {(text: string, params?: any[]) => Promise<{rows: any[], rowCount: number}>} deps.query
 */
const buildEmergencyContactHandlers = ({ query }) => {
  const getEmergencyContacts = async (req, res) => {
    try {
      const result = await query(
        'SELECT emergency_contacts, emergency_contact FROM users WHERE id = $1',
        [req.user.id]
      );
      if (result.rows.length === 0) return notFound(res, 'User not found');
      return success(res, contactsBody(result.rows[0]));
    } catch (err) {
      console.error(`Get emergency contacts error (user ${req.user && req.user.id}):`, err);
      return error(res, 'Failed to load your trusted contacts', 500);
    }
  };

  /**
   * Replaces the whole list. The app sends every contact, in order, after any
   * add or remove, so two edits never have to be merged here. Duplicates are
   * dropped (the first kept) rather than refused.
   */
  const replaceEmergencyContacts = async (req, res) => {
    try {
      const { contacts, error: listError } = readContactList((req.body || {}).contacts);
      if (listError) return error(res, listError, 400);

      const result = await query(
        `UPDATE users
            SET emergency_contacts = $1::text[],
                emergency_contact  = $2,
                updated_at         = NOW()
          WHERE id = $3
          RETURNING emergency_contacts, emergency_contact`,
        [contacts, contacts.length > 0 ? contacts[0] : null, req.user.id]
      );
      if (result.rows.length === 0) return notFound(res, 'User not found');
      return success(res, contactsBody(result.rows[0]), 'Trusted contacts saved');
    } catch (err) {
      if (err.code === CHECK_VIOLATION) {
        return error(res, `You can save up to ${MAX_EMERGENCY_CONTACTS} trusted contacts.`, 400);
      }
      console.error(`Save emergency contacts error (user ${req.user && req.user.id}):`, err);
      return error(res, 'Failed to save your trusted contacts', 500);
    }
  };

  return { getEmergencyContacts, replaceEmergencyContacts };
};

const { getEmergencyContacts, replaceEmergencyContacts } = buildEmergencyContactHandlers({ query: db.query });

module.exports = { buildEmergencyContactHandlers, getEmergencyContacts, replaceEmergencyContacts };
