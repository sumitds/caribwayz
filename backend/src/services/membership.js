/**
 * Member businesses (migration 025, docs/members-contract.md): shaping rows
 * for the API and choosing a fee tier. No database access here, so the
 * public and admin controllers share it and tests run it directly.
 */

const MEMBERSHIP_STATUSES = Object.freeze(['pending', 'active', 'expired', 'cancelled']);
const APPLICATION_STATUSES = Object.freeze(['new', 'invoiced', 'paid', 'rejected']);

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
  promo_text: currentPromo(row.promo_text, row.promo_expires_at, now),
  distance_m: Math.round(Number(row.distance_m)),
});

/** A business row for the admin panel: coordinates as numbers, tier name joined. */
const adminBusiness = (row) => ({
  ...row,
  latitude: toNumberOrNull(row.latitude),
  longitude: toNumberOrNull(row.longitude),
});

/** An application row for the admin panel, the quoted fee as a number. */
const adminApplication = (row) => ({
  ...row,
  quoted_fee: toNumberOrNull(row.quoted_fee),
  latitude: toNumberOrNull(row.latitude),
  longitude: toNumberOrNull(row.longitude),
});

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
  publicMember,
  adminBusiness,
  adminApplication,
  clampRadius,
  boundingBox,
};
