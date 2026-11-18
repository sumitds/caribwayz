/**
 * Member businesses (migration 025, docs/members-contract.md): shaping rows
 * for the API and choosing a fee tier. No database access here, so the
 * public and admin controllers share it and tests run it directly.
 */

// suspended (migration 027): paused by an admin without being cancelled.
const MEMBERSHIP_STATUSES = Object.freeze(['pending', 'active', 'suspended', 'expired', 'cancelled']);
const APPLICATION_STATUSES = Object.freeze(['new', 'invoiced', 'paid', 'rejected']);

// Version 1 plan item 2 (migration 034): an offer an admin enters for a business.
const CAMPAIGN_KINDS = Object.freeze(['promotional', 'seasonal']);
/** Where a campaign stands on a given day; see campaignState. */
const CAMPAIGN_STATES = Object.freeze(['scheduled', 'running', 'finished', 'ended']);

/**
 * Featured placement and campaigns run by calendar day in Jamaica, both ends
 * inclusive (migration 034). Jamaica keeps UTC-5 all year.
 */
const MEMBER_TIME_ZONE = 'America/Jamaica';

/** Today in Jamaica, as SQL. */
const JAMAICA_TODAY_SQL = `(NOW() AT TIME ZONE '${MEMBER_TIME_ZONE}')::date`;

/** Renewal reminders list memberships ending within this many days, and those ended within it. */
const RENEWAL_WINDOW_DAYS = 30;

const NEARBY_DEFAULT_RADIUS_M = 2000;
const NEARBY_MIN_RADIUS_M = 50;
const NEARBY_MAX_RADIUS_M = 20000;
const NEARBY_MAX_RESULTS = 50;

/**
 * The businesses the app shows as members, as a WHERE condition on
 * businesses (unaliased): listed, active, and not past their expiry. The
 * same rule as GET /members/nearby.
 */
const LISTED_MEMBER_SQL = `is_active = TRUE AND membership_status = 'active'
  AND (membership_expires_at IS NULL OR membership_expires_at > NOW())`;

/**
 * pg returns NUMERIC and DECIMAL columns as strings, so a fee of 20 arrives as
 * "20.00". The contract promises JSON numbers; NULL stays null.
 */
const toNumberOrNull = (value) => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** The tier as GET /members/tiers returns it. */
const publicTier = (row) => ({
  id: row.id,
  name: row.name,
  min_employees: row.min_employees,
  max_employees: row.max_employees === null || row.max_employees === undefined ? null : row.max_employees,
  annual_fee: toNumberOrNull(row.annual_fee),
  currency: row.currency,
  is_provisional: row.is_provisional === true,
});

/** Every column of a tier, with the fee as a number, for the admin panel. */
const adminTier = (row) => ({
  ...publicTier(row),
  sort_order: row.sort_order === undefined ? null : row.sort_order,
  is_active: row.is_active !== false,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

/**
 * The tier whose employee range holds [employeeCount]: min_employees and
 * max_employees are both inclusive, and a NULL max has no upper bound. When
 * ranges overlap (an admin can make them), the first by sort_order wins, then
 * the lowest minimum. Inactive tiers are never chosen. Null when none fits.
 */
const selectTier = (tiers, employeeCount) => {
  if (!Array.isArray(tiers) || !Number.isInteger(employeeCount)) return null;
  const fitting = tiers.filter((t) => t.is_active !== false &&
    employeeCount >= t.min_employees &&
    (t.max_employees === null || t.max_employees === undefined || employeeCount <= t.max_employees));
  if (fitting.length === 0) return null;
  const order = (t) => (t.sort_order === null || t.sort_order === undefined ? Number.MAX_SAFE_INTEGER : t.sort_order);
  return [...fitting].sort((a, b) => order(a) - order(b) || a.min_employees - b.min_employees || a.id - b.id)[0];
};

/**
 * The promotion to show now, or null when there is none, it is only spaces,
 * or its expiry has passed. A promotion with no expiry runs until removed.
 */
const currentPromo = (promoText, promoExpiresAt, now = new Date()) => {
  if (typeof promoText !== 'string' || promoText.trim() === '') return null;
  if (promoExpiresAt !== null && promoExpiresAt !== undefined) {
    const expires = new Date(promoExpiresAt);
    if (Number.isNaN(expires.getTime()) || expires.getTime() <= now.getTime()) return null;
  }
  return promoText.trim();
};

const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether [value] is a real calendar day written YYYY-MM-DD (no 2026-02-30). */
const isCalendarDay = (value) => {
  if (typeof value !== 'string') return false;
  const match = CALENDAR_DAY.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

/**
 * The calendar day [at] falls on in Jamaica, YYYY-MM-DD. Featured placement
 * and campaigns change at midnight there, not at midnight UTC.
 */
const jamaicaDay = (at = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MEMBER_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at);
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};

/**
 * A DATE column as YYYY-MM-DD, or null. pg turns a DATE into a Date at local
 * midnight, so its local day is the stored day; text is passed through.
 */
const calendarDate = (value) => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const text = String(value).slice(0, 10);
  return isCalendarDay(text) ? text : null;
};

/** [day] (YYYY-MM-DD) moved by [days] calendar days. */
const addDays = (day, days) => {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
};

/** Whole calendar days from [fromDay] to [toDay], both YYYY-MM-DD; negative when toDay is earlier. */
const daysBetween = (fromDay, toDay) => {
  const utc = (day) => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((utc(toDay) - utc(fromDay)) / 86400000);
};

/**
 * Whether the business is featured on [today] (YYYY-MM-DD in Jamaica): ticked,
 * and today is on or before its end date. Whether it is a member the app shows
 * at all is checked separately.
 */
const isFeaturedOn = (business, today) => {
  if (!business || business.is_featured !== true) return false;
  const until = calendarDate(business.featured_until);
  return until !== null && today <= until;
};

/**
 * Where a campaign stands on [today] (YYYY-MM-DD in Jamaica): 'ended' (an
 * admin ended it early), 'scheduled', 'running' (start and end days
 * inclusive) or 'finished'.
 */
const campaignState = (campaign, today) => {
  if (campaign.ended_at !== null && campaign.ended_at !== undefined) return 'ended';
  if (today < calendarDate(campaign.start_date)) return 'scheduled';
  if (today > calendarDate(campaign.end_date)) return 'finished';
  return 'running';
};

/**
 * The campaign the app uses for a business on [today], or null. When several
 * run at once the one that started latest wins (a seasonal offer entered on
 * top of a longer promotion replaces it while it runs), then the one entered
 * latest, then the highest id. NEARBY_SQL applies the same rule.
 */
const pickCampaign = (campaigns, today) => {
  const running = (campaigns || []).filter((c) => campaignState(c, today) === 'running');
  if (running.length === 0) return null;
  const time = (value) => (value ? new Date(value).getTime() : 0);
  return [...running].sort((a, b) => {
    const byStart = calendarDate(b.start_date).localeCompare(calendarDate(a.start_date));
    if (byStart !== 0) return byStart;
    const byCreated = time(b.created_at) - time(a.created_at);
    if (byCreated !== 0) return byCreated;
    return String(b.id).localeCompare(String(a.id));
  })[0];
};

/** A campaign for the admin panel: dates as YYYY-MM-DD, where it stands on [today], and whether the app uses it. */
const adminCampaign = (row, today, inUse = false) => ({
  id: row.id,
  business_id: row.business_id,
  business_name: row.business_name ?? null,
  kind: row.kind,
  offer_text: row.offer_text,
  start_date: calendarDate(row.start_date),
  end_date: calendarDate(row.end_date),
  ended_at: row.ended_at ?? null,
  created_by_name: row.created_by_name ?? null,
  created_at: row.created_at,
  updated_at: row.updated_at,
  state: campaignState(row, today),
  in_use: inUse,
});

/**
 * The offer the app speaks and shows: a running campaign's offer
 * (campaign_offer, picked by NEARBY_SQL), otherwise the business's own
 * promotion, under its expiry. Null when there is neither.
 */
const currentOffer = (row, now = new Date()) => {
  if (typeof row.campaign_offer === 'string' && row.campaign_offer.trim() !== '') return row.campaign_offer.trim();
  return currentPromo(row.promo_text, row.promo_expires_at, now);
};

/** A business as GET /members/nearby returns it. */
const publicMember = (row, now = new Date()) => ({
  id: row.id,
  name: row.name,
  category: row.category ?? null,
  latitude: toNumberOrNull(row.latitude),
  longitude: toNumberOrNull(row.longitude),
  address: row.address ?? null,
  phone: row.phone ?? null,
  website: row.website ?? null,
  description: row.description ?? null,
  promo_text: currentOffer(row, now),
  distance_m: Math.round(Number(row.distance_m)),
  // Added by migration 034; NEARBY_SQL works it out by the Jamaica day.
  featured: row.featured_now === true,
});

/** A business row for the admin panel: coordinates as numbers, tier name joined, featured_until as YYYY-MM-DD. */
const adminBusiness = (row) => {
  const shaped = {
    ...row,
    latitude: toNumberOrNull(row.latitude),
    longitude: toNumberOrNull(row.longitude),
  };
  if (Object.prototype.hasOwnProperty.call(row, 'featured_until')) shaped.featured_until = calendarDate(row.featured_until);
  return shaped;
};

/**
 * The address a renewal reminder goes to: the representative's email
 * (contact_email, copied from the application), else the business email.
 * Null when there is neither.
 */
const reminderRecipient = (business) => {
  for (const field of ['contact_email', 'business_email']) {
    const value = typeof business?.[field] === 'string' ? business[field].trim() : '';
    if (value !== '') return value;
  }
  return null;
};

/**
 * A membership on the renewal reminders list, at [now]. days_left counts
 * calendar days in Jamaica from today to the day the membership ends
 * (0 = ends today, negative = ended that many days ago).
 */
const renewalEntry = (row, now = new Date()) => {
  const today = jamaicaDay(now);
  const expires = new Date(row.membership_expires_at);
  const lastSent = row.last_reminder_sent_at ? new Date(row.last_reminder_sent_at) : null;
  return {
    id: row.id,
    name: row.name,
    membership_status: row.membership_status,
    membership_expires_at: row.membership_expires_at,
    tier_name: row.tier_name ?? null,
    contact_name: row.contact_name ?? null,
    recipient_email: reminderRecipient(row),
    days_left: daysBetween(today, jamaicaDay(expires)),
    expired: expires.getTime() <= now.getTime(),
    last_reminder_sent_at: row.last_reminder_sent_at ?? null,
    last_reminder_sent_by_name: row.last_reminder_sent_by_name ?? null,
    reminded_today: lastSent !== null && jamaicaDay(lastSent) === today,
  };
};

/** An application row for the admin panel, the quoted fee as a number. */
const adminApplication = (row) => ({
  ...row,
  quoted_fee: toNumberOrNull(row.quoted_fee),
  latitude: toNumberOrNull(row.latitude),
  longitude: toNumberOrNull(row.longitude),
});

/**
 * The name a new member listing is shown under: the application's trading
 * name when it has one that is not only spaces, otherwise its registered
 * business name. Both are trimmed.
 */
const listingName = (application) => {
  const trading = typeof application?.trading_name === 'string' ? application.trading_name.trim() : '';
  if (trading !== '') return trading;
  return String(application?.business_name ?? '').trim();
};

/** The radius to search, from the radius_m query value (already validated as an integer when present). */
const clampRadius = (value) => {
  if (value === undefined || value === null || value === '') return NEARBY_DEFAULT_RADIUS_M;
  const n = Number(value);
  if (!Number.isFinite(n)) return NEARBY_DEFAULT_RADIUS_M;
  return Math.min(Math.max(Math.round(n), NEARBY_MIN_RADIUS_M), NEARBY_MAX_RADIUS_M);
};

/**
 * The box around a point that a nearby search pre-filters on, before the
 * exact distance: { latMin, latMax, lngRanges }, where lngRanges is one or
 * two [west, east] pairs inside -180..180.
 *
 * A degree of latitude is about 111 km everywhere; a degree of longitude
 * shrinks with latitude. Across the antimeridian the longitude range wraps,
 * so it is split in two. When the box reaches a pole, or is wider than the
 * whole globe, every longitude is inside it.
 */
const boundingBox = (latitude, longitude, radiusMeters) => {
  const latDelta = radiusMeters / 111000;
  const latMin = latitude - latDelta;
  const latMax = latitude + latDelta;
  const everyLongitude = { latMin: Math.max(latMin, -90), latMax: Math.min(latMax, 90), lngRanges: [[-180, 180]] };
  if (latMin <= -90 || latMax >= 90) return everyLongitude;

  const lngDelta = radiusMeters / (111000 * Math.cos((latitude * Math.PI) / 180));
  if (!Number.isFinite(lngDelta) || lngDelta >= 180) return everyLongitude;

  const west = longitude - lngDelta;
  const east = longitude + lngDelta;
  let lngRanges;
  if (west < -180) lngRanges = [[west + 360, 180], [-180, east]];
  else if (east > 180) lngRanges = [[west, 180], [-180, east - 360]];
  else lngRanges = [[west, east]];
  return { latMin, latMax, lngRanges };
};

module.exports = {
  MEMBERSHIP_STATUSES,
  APPLICATION_STATUSES,
  CAMPAIGN_KINDS,
  CAMPAIGN_STATES,
  MEMBER_TIME_ZONE,
  JAMAICA_TODAY_SQL,
  RENEWAL_WINDOW_DAYS,
  NEARBY_DEFAULT_RADIUS_M,
  NEARBY_MIN_RADIUS_M,
  NEARBY_MAX_RADIUS_M,
  NEARBY_MAX_RESULTS,
  LISTED_MEMBER_SQL,
  toNumberOrNull,
  publicTier,
  adminTier,
  selectTier,
  currentPromo,
  currentOffer,
  publicMember,
  adminBusiness,
  isCalendarDay,
  jamaicaDay,
  calendarDate,
  addDays,
  daysBetween,
  isFeaturedOn,
  campaignState,
  pickCampaign,
  adminCampaign,
  reminderRecipient,
  renewalEntry,
  adminApplication,
  listingName,
  clampRadius,
  boundingBox,
};
