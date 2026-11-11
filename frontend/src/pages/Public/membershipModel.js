// Public /membership page logic, kept free of React so it runs under
// node --test. The API side is POST /members/apply and GET /members/tiers
// (docs/members-contract.md).

import { isWebAddress, WEB_ADDRESS_MESSAGE } from '../../utils/webAddress.js';

/**
 * The hidden field only a form-filling bot fills (HONEYPOT_FIELD in
 * api/src/controllers/membershipController.js). The page always sends it
 * empty.
 */
export const HONEYPOT_FIELD = 'cw_hp';

export const FEE_TO_BE_CONFIRMED = 'Fee to be confirmed';
export const INVOICE_BY_EMAIL = "We'll email you an invoice.";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[0-9+().\-\s]{5,40}$/;

/** "USD 20.00 a year", or "Fee to be confirmed" when the fee is not set. */
export const formatFee = (tier) => {
  if (!tier || typeof tier.annual_fee !== 'number' || !Number.isFinite(tier.annual_fee)) return FEE_TO_BE_CONFIRMED;
  return `${tier.currency || 'USD'} ${tier.annual_fee.toFixed(2)} a year`;
};

/** "1 to 15 employees", or "100 or more employees" for a tier with no upper bound. */
export const tierRange = (tier) => {
  if (tier.max_employees === null || tier.max_employees === undefined) return `${tier.min_employees} or more employees`;
  if (tier.max_employees === tier.min_employees) {
    return `${tier.min_employees} employee${tier.min_employees === 1 ? '' : 's'}`;
  }
  return `${tier.min_employees} to ${tier.max_employees} employees`;
};

/**
 * The tier the form's employee count falls in, for the hint under the field.
 * Only a hint: the server chooses the tier when the form arrives. Matches the
 * API's choice (services/membership.js selectTier) for the tiers it lists,
 * which are already in sort order.
 */
export const tierForCount = (tiers, count) => {
  const n = Number(count);
  if (!Array.isArray(tiers) || !Number.isInteger(n) || n < 1) return null;
  return tiers.find((t) => n >= t.min_employees && (t.max_employees === null || t.max_employees === undefined || n <= t.max_employees)) || null;
};

/**
 * The form's fields, in the order of the Business Membership Policy,
 * section 6. business_name is the registered name; phone is the business
 * telephone; contact_name, contact_position, contact_phone and email are the
 * owner or authorized representative. latitude and longitude are the map
 * pin, text until sent. accept_terms is the tick box, a boolean.
 */
export const EMPTY_FORM = Object.freeze({
  business_name: '', trading_name: '', category: '', description: '', address: '', latitude: '', longitude: '',
  phone: '', business_email: '', website: '',
  contact_name: '', contact_position: '', contact_phone: '', email: '',
  employee_count: '', message: '', accept_terms: false, [HONEYPOT_FIELD]: '',
});

const LIMITS = {
  business_name: 200, trading_name: 200, category: 100, description: 1000, address: 500, phone: 40,
  business_email: 255, website: 500, contact_name: 200, contact_position: 100, contact_phone: 40, email: 255, message: 2000,
};

/** Optional text sent only when filled in. */
const OPTIONAL_TEXT = ['trading_name', 'description', 'business_email', 'website', 'message'];

/**
 * Checks the form the way the API will, so most mistakes show at once next
 * to the field. Returns { errors } (field -> message) when something is
 * wrong, or { body } ready to send: trimmed, empty optional fields left out.
 */
export const buildApplication = (form) => {
  const value = (field) => (typeof form[field] === 'string' ? form[field].trim() : '');
  const errors = {};
  const required = (field, message) => { if (value(field) === '') errors[field] = message; };

  if (value('business_name').length < 2) errors.business_name = 'Enter the registered business name.';
  required('category', 'Enter the type of business, such as restaurant or gas station.');
  required('address', 'Enter the physical address of the business.');
  required('phone', 'Enter the business telephone number.');
  required('contact_name', 'Enter the full name of the owner or authorized representative.');
  required('contact_position', 'Enter their position or relationship to the business, such as Owner or Manager.');
  required('contact_phone', 'Enter a contact number for the owner or representative.');
  if (!EMAIL_PATTERN.test(value('email'))) errors.email = 'Enter an email address, such as name@business.com.';

  for (const field of ['phone', 'contact_phone']) {
    if (!errors[field] && !PHONE_PATTERN.test(value(field))) errors[field] = 'Enter a phone number using digits, spaces, +, - or brackets.';
  }
  if (value('business_email') !== '' && !EMAIL_PATTERN.test(value('business_email'))) {
    errors.business_email = 'Enter an email address, such as info@business.com, or leave it empty.';
  }
  if (!isWebAddress(value('website'))) errors.website = WEB_ADDRESS_MESSAGE;

  const countText = value('employee_count');
  const count = Number(countText);
  if (countText === '' || !/^[0-9]+$/.test(countText) || !Number.isInteger(count) || count < 1 || count > 1000000) {
    errors.employee_count = 'Enter the number of employees as a whole number, 1 or more.';
  }

  // The map pin: both or neither, set by tapping the map or typed.
  const latText = value('latitude');
  const lngText = value('longitude');
  let location = null;
  if (latText !== '' || lngText !== '') {
    const lat = Number(latText);
    const lng = Number(lngText);
    if (latText === '' || lngText === '' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      errors.latitude = 'Tap the map where the business is, or clear the pin.';
    } else {
      location = { latitude: lat, longitude: lng };
    }
  }

  if (form.accept_terms !== true) {
    errors.accept_terms = 'Tick the box to accept the Business Membership Policy and the Terms and Conditions.';
  }

  for (const [field, max] of Object.entries(LIMITS)) {
    if (!errors[field] && value(field).length > max) errors[field] = `Use at most ${max} characters.`;
  }

  if (Object.keys(errors).length > 0) return { errors };

  const body = {
    business_name: value('business_name'),
    category: value('category'),
    address: value('address'),
    phone: value('phone'),
    contact_name: value('contact_name'),
    contact_position: value('contact_position'),
    contact_phone: value('contact_phone'),
    email: value('email'),
    employee_count: count,
    accept_terms: true,
  };
  if (location) Object.assign(body, location);
  // Whatever is in the hidden field goes as typed; the API drops the form when it is filled.
  if (typeof form[HONEYPOT_FIELD] === 'string' && form[HONEYPOT_FIELD] !== '') body[HONEYPOT_FIELD] = form[HONEYPOT_FIELD];
  for (const field of OPTIONAL_TEXT) {
    if (value(field) !== '') body[field] = value(field);
  }
  return { body };
};

/**
 * What the thank-you screen says about paying, from the 201 answer's data:
 * { fee, instructions } where instructions is the admin's text, or null when
 * there is none yet and the page says the team will email an invoice.
 */
export const thankYou = (data) => {
  const instructions = typeof data?.payment_instructions === 'string' && data.payment_instructions.trim() !== ''
    ? data.payment_instructions
    : null;
  return {
    tierName: data?.tier?.name || null,
    fee: data?.tier ? formatFee(data.tier) : FEE_TO_BE_CONFIRMED,
    provisional: data?.tier?.is_provisional === true,
    instructions,
  };
};

/** The API's own field messages from a 400, by field, or null. */
export const fieldErrorsFrom = (error) => {
  const list = error?.response?.status === 400 ? error.response.data?.errors : null;
  if (!Array.isArray(list) || list.length === 0) return null;
  const errors = {};
  for (const e of list) {
    if (e && typeof e.path === 'string' && typeof e.msg === 'string' && !errors[e.path]) errors[e.path] = e.msg;
  }
  return Object.keys(errors).length > 0 ? errors : null;
};

/** One readable sentence for a failed submission. */
export const submitErrorMessage = (error) => {
  const status = error?.response?.status;
  if (status === 429) {
    return error.response.data?.message || 'Too many applications from this connection. Please wait an hour and try again.';
  }
  if (status === 400) return 'Some details need fixing. Check the fields marked below.';
  if (!error?.response) return 'We could not reach CaribWayz. Check your connection and try again.';
  return 'Something went wrong on our side and your application was not sent. Please try again.';
};
