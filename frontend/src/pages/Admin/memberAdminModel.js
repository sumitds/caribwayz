// Admin member pages logic (businesses, tiers, applications), kept free of
// React so it runs under node --test. The API side is /admin/businesses,
// /admin/membership-tiers and /admin/membership-applications
// (docs/members-contract.md).

import { isWebAddress, WEB_ADDRESS_MESSAGE } from '../../utils/webAddress.js';

export const MEMBERSHIP_STATUSES = ['pending', 'active', 'expired', 'cancelled'];
export const APPLICATION_STATUSES = ['new', 'invoiced', 'paid', 'rejected'];

const pad = (n) => String(n).padStart(2, '0');

/** An ISO timestamp as the value of an <input type="datetime-local">, in local time; '' for none. */
export const toDateTimeLocal = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** A datetime-local value back to ISO; null for empty. Undefined when it cannot be read. */
export const fromDateTimeLocal = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

/**
 * Whether the app shows this business on the map now: listed, active, and
 * not past its expiry. The same rule as GET /members/nearby.
 */
export const isShownOnMap = (business, now = new Date()) => {
  if (!business || business.is_active === false || business.membership_status !== 'active') return false;
  if (!business.membership_expires_at) return true;
  return new Date(business.membership_expires_at).getTime() > now.getTime();
};

/** Whether the promotion is showing now (set, and not past its expiry). */
export const isPromoLive = (business, now = new Date()) => {
  if (!business?.promo_text || business.promo_text.trim() === '') return false;
  if (!business.promo_expires_at) return true;
  return new Date(business.promo_expires_at).getTime() > now.getTime();
};

export const EMPTY_BUSINESS_FORM = Object.freeze({
  name: '', category: '', latitude: '', longitude: '', address: '', phone: '', website: '', description: '',
  contact_email: '', employee_count: '', tier_id: '', membership_status: 'pending', membership_expires_at: '',
  promo_text: '', promo_expires_at: '', is_active: true,
});

/** A business row as the edit form's state (every field a string, except is_active). */
export const businessFormFrom = (b) => ({
  name: b.name || '',
  category: b.category || '',
  latitude: b.latitude === null || b.latitude === undefined ? '' : String(b.latitude),
  longitude: b.longitude === null || b.longitude === undefined ? '' : String(b.longitude),
  address: b.address || '',
  phone: b.phone || '',
  website: b.website || '',
  description: b.description || '',
  contact_email: b.contact_email || '',
  employee_count: b.employee_count === null || b.employee_count === undefined ? '' : String(b.employee_count),
  tier_id: b.tier_id === null || b.tier_id === undefined ? '' : String(b.tier_id),
  membership_status: b.membership_status || 'pending',
  membership_expires_at: toDateTimeLocal(b.membership_expires_at),
  promo_text: b.promo_text || '',
  promo_expires_at: toDateTimeLocal(b.promo_expires_at),
  is_active: b.is_active !== false,
});

const TEXT_FIELDS = ['category', 'address', 'phone', 'website', 'description', 'contact_email', 'promo_text'];

/**
 * The request body for POST or PATCH /admin/businesses from the form, or
 * { errors } (field -> message). Empty optional fields are sent as null so
 * an edit can clear them.
 */
export const businessPayload = (form) => {
  const errors = {};
  const name = form.name.trim();
  if (name === '') errors.name = 'Name is required';

  const lat = Number(form.latitude);
  const lng = Number(form.longitude);
  if (form.latitude.trim() === '' || !Number.isFinite(lat) || lat < -90 || lat > 90) errors.latitude = 'Latitude from -90 to 90';
  if (form.longitude.trim() === '' || !Number.isFinite(lng) || lng < -180 || lng > 180) errors.longitude = 'Longitude from -180 to 180';

  let employeeCount = null;
  if (form.employee_count.trim() !== '') {
    employeeCount = Number(form.employee_count);
    if (!Number.isInteger(employeeCount) || employeeCount < 1) errors.employee_count = 'A whole number, 1 or more';
  }
  if (form.promo_text.trim().length > 280) errors.promo_text = 'At most 280 characters';
  if (form.phone.trim().length > 40) errors.phone = 'At most 40 characters';
  if (!isWebAddress(form.website.trim())) errors.website = WEB_ADDRESS_MESSAGE;
  if (form.contact_email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.contact_email.trim())) {
    errors.contact_email = 'An email address';
  }

  const membershipExpires = fromDateTimeLocal(form.membership_expires_at);
  if (membershipExpires === undefined) errors.membership_expires_at = 'A date and time';
  const promoExpires = fromDateTimeLocal(form.promo_expires_at);
  if (promoExpires === undefined) errors.promo_expires_at = 'A date and time';

  if (!MEMBERSHIP_STATUSES.includes(form.membership_status)) errors.membership_status = 'Choose a status';
  if (Object.keys(errors).length > 0) return { errors };

  const body = {
    name,
    latitude: lat,
    longitude: lng,
    employee_count: employeeCount,
    tier_id: form.tier_id === '' ? null : Number(form.tier_id),
    membership_status: form.membership_status,
    membership_expires_at: membershipExpires,
    promo_expires_at: promoExpires,
    is_active: form.is_active !== false,
  };
  for (const field of TEXT_FIELDS) {
    const v = form[field].trim();
    body[field] = v === '' ? null : v;
  }
  return { body };
};

/** "1-15", "100+" for a tier's employee range. */
export const tierRangeShort = (tier) => (tier.max_employees === null || tier.max_employees === undefined
  ? `${tier.min_employees}+`
  : `${tier.min_employees}-${tier.max_employees}`);

/** "USD 20.00", or "Not set" for a fee not set yet. */
export const feeLabel = (amount, currency = 'USD') => (typeof amount === 'number' && Number.isFinite(amount)
  ? `${currency} ${amount.toFixed(2)}`
  : 'Not set');

export const EMPTY_TIER_FORM = Object.freeze({
  name: '', min_employees: '', max_employees: '', annual_fee: '', currency: 'USD', is_provisional: true, sort_order: '', is_active: true,
});

export const tierFormFrom = (t) => ({
  name: t.name || '',
  min_employees: String(t.min_employees ?? ''),
  max_employees: t.max_employees === null || t.max_employees === undefined ? '' : String(t.max_employees),
  annual_fee: t.annual_fee === null || t.annual_fee === undefined ? '' : String(t.annual_fee),
  currency: t.currency || 'USD',
  is_provisional: t.is_provisional !== false,
  sort_order: t.sort_order === null || t.sort_order === undefined ? '' : String(t.sort_order),
  is_active: t.is_active !== false,
});

/**
 * The request body for POST or PATCH /admin/membership-tiers, or { errors }.
 * An empty maximum is "or more"; an empty fee is "not set yet".
 */
export const tierPayload = (form) => {
  const errors = {};
  const name = form.name.trim();
  if (name === '') errors.name = 'Name is required';
  const min = Number(form.min_employees);
  if (form.min_employees.trim() === '' || !Number.isInteger(min) || min < 1) errors.min_employees = 'A whole number, 1 or more';
  let max = null;
  if (form.max_employees.trim() !== '') {
    max = Number(form.max_employees);
    if (!Number.isInteger(max) || max < 1) errors.max_employees = 'A whole number, or empty for no limit';
    else if (!errors.min_employees && max < min) errors.max_employees = 'At least the minimum';
  }
  let fee = null;
  if (form.annual_fee.trim() !== '') {
    fee = Number(form.annual_fee);
    if (!Number.isFinite(fee) || fee < 0) errors.annual_fee = 'An amount, or empty if not set yet';
    else fee = Math.round(fee * 100) / 100;
  }
  const currency = form.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) errors.currency = 'A three-letter code such as USD';
  let sortOrder = null;
  if (form.sort_order.trim() !== '') {
    sortOrder = Number(form.sort_order);
    if (!Number.isInteger(sortOrder) || sortOrder < 0) errors.sort_order = 'A whole number, 0 or more';
  }
  if (Object.keys(errors).length > 0) return { errors };
  return {
    body: {
      name, min_employees: min, max_employees: max, annual_fee: fee, currency,
      is_provisional: form.is_provisional !== false, sort_order: sortOrder, is_active: form.is_active !== false,
    },
  };
};

/**
 * The body for POST /admin/membership-applications/:id/activate, or
 * { errors }. The location may be left empty when the application already
 * has one; both or neither.
 */
export const activationPayload = ({ latitude, longitude, months }) => {
  const errors = {};
  const body = {};
  const latText = String(latitude ?? '').trim();
  const lngText = String(longitude ?? '').trim();
  if (latText !== '' || lngText !== '') {
    const lat = Number(latText);
    const lng = Number(lngText);
    if (latText === '' || !Number.isFinite(lat) || lat < -90 || lat > 90) errors.latitude = 'Latitude from -90 to 90';
    if (lngText === '' || !Number.isFinite(lng) || lng < -180 || lng > 180) errors.longitude = 'Longitude from -180 to 180';
    body.latitude = lat;
    body.longitude = lng;
  }
  const m = Number(String(months ?? '').trim() || 12);
  if (!Number.isInteger(m) || m < 1 || m > 120) errors.months = 'From 1 to 120 months';
  body.months = m;
  return Object.keys(errors).length > 0 ? { errors } : { body };
};

/** The API's message for a failed admin request, or [fallback]. */
export const apiMessage = (error, fallback) => {
  const data = error?.response?.data;
  if (Array.isArray(data?.errors) && data.errors.length > 0 && typeof data.errors[0].msg === 'string') return data.errors[0].msg;
  if (typeof data?.message === 'string' && data.message !== '') return data.message;
  return fallback;
};
