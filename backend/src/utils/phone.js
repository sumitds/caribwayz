/**
 * Trusted-contact phone numbers.
 *
 * The app has always accepted an emergency contact of 7 to 15 characters made
 * of digits and an optional leading "+" (sign-up and Edit Profile). The API
 * checks the same rule, after removing the spaces, dashes, dots and brackets
 * people type or paste, so "+1 (876) 555-0199" and "+18765550199" are one
 * number.
 */

/** How many trusted contacts one account can have. Migration 023 caps the column too. */
const MAX_EMERGENCY_CONTACTS = 5;

const SEPARATORS = /[\s().-]/g;
const PHONE_PATTERN = /^\+?[0-9]+$/;
const MIN_LENGTH = 7;
const MAX_LENGTH = 15;

/** [raw] as a stored number, or null when it is not a usable phone number. */
const normalizeContactPhone = (raw) => {
  if (typeof raw !== 'string') return null;
  const compact = raw.trim().replace(SEPARATORS, '');
  if (!PHONE_PATTERN.test(compact)) return null;
  if (compact.length < MIN_LENGTH || compact.length > MAX_LENGTH) return null;
  return compact;
};

/**
 * What two numbers must share to be the same contact: their digits. A number
 * saved once with "+" and once without is still one person.
 */
const contactKey = (phone) => String(phone).replace(/\D/g, '');

/**
 * Checks and cleans a whole contact list. Returns { contacts } with each number
 * normalised and duplicates dropped (the first one kept, so order is kept), or
 * { error } with a sentence the app can show.
 */
const readContactList = (value) => {
  if (!Array.isArray(value)) return { error: 'contacts must be a list of phone numbers' };
  // Duplicates are dropped below, so a list may be a little longer than the
  // cap; one far longer is not a contact list.
  if (value.length > MAX_EMERGENCY_CONTACTS * 4) {
    return { error: `You can save up to ${MAX_EMERGENCY_CONTACTS} trusted contacts.` };
  }
  const contacts = [];
  const seen = new Set();
  for (const raw of value) {
    const phone = normalizeContactPhone(raw);
    if (phone === null) {
      const shown = typeof raw === 'string' && raw.trim() !== '' ? `"${raw.trim().slice(0, 40)}"` : 'One of the numbers';
      return { error: `${shown} is not a valid phone number. Use 7 to 15 digits, with an optional + at the start.` };
    }
    const key = contactKey(phone);
    if (seen.has(key)) continue;
    seen.add(key);
    contacts.push(phone);
  }
  if (contacts.length > MAX_EMERGENCY_CONTACTS) {
    return { error: `You can save up to ${MAX_EMERGENCY_CONTACTS} trusted contacts.` };
  }
  return { contacts };
};

module.exports = { MAX_EMERGENCY_CONTACTS, normalizeContactPhone, contactKey, readContactList };
