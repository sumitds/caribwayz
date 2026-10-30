const crypto = require('crypto');
const db = require('../config/db');
const emailService = require('../services/emailService');
const membership = require('../services/membership');
const { success, created, error } = require('../utils/response');

const ACTIVE_TIERS_SQL = `SELECT id, name, min_employees, max_employees, annual_fee, currency, is_provisional, sort_order, is_active
   FROM membership_tiers
  WHERE is_active = TRUE
  ORDER BY sort_order NULLS LAST, min_employees, id`;

/**
 * Members within [radiusMeters] of a point, nearest first. Distance is the
 * haversine great-circle distance worked out in SQL (there is no PostGIS);
 * the box around the point only lets the latitude/longitude index skip rows
 * far away, as the shelter and roadside lookups do. Only members that are
 * listed, paid up and not past their expiry are returned.
 */
const NEARBY_SQL = `SELECT id, name, category, latitude, longitude, address, phone, website, description,
        promo_text, promo_expires_at, distance_m
   FROM (
     SELECT b.*,
            2 * 6371000 * ASIN(LEAST(1, SQRT(
              POWER(SIN(RADIANS(b.latitude::float8 - $1) / 2), 2) +
              COS(RADIANS($1)) * COS(RADIANS(b.latitude::float8)) *
              POWER(SIN(RADIANS(b.longitude::float8 - $2) / 2), 2)
            ))) AS distance_m
       FROM businesses b
      WHERE b.is_active = TRUE
        AND b.membership_status = 'active'
        AND (b.membership_expires_at IS NULL OR b.membership_expires_at > NOW())
        AND b.latitude BETWEEN $3 AND $4
        AND (b.longitude BETWEEN $5 AND $6 OR b.longitude BETWEEN $7 AND $8)
   ) AS m
  WHERE distance_m <= $9
  ORDER BY distance_m, id
  LIMIT $10`;

/**
 * A field the /membership page hides from people. Only a form-filling bot
 * puts anything in it; such an application is answered as if it were
 * received, and neither stored nor emailed.
 */
const HONEYPOT_FIELD = 'cw_hp';

/** Optional text from the form: trimmed, and null when left empty. */
const optionalText = (value) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
};

/**
 * Builds the handlers with their dependencies passed in, so tests can supply
 * a fake query and mailer. The module exports a set wired to the real
 * database and SMTP.
 *
 * [adminContactEmail] is where an application notice goes when the
 * membership settings name no contact address.
 */
const buildMembershipHandlers = ({ query, sendNotice, isEmailConfigured, adminContactEmail, now = () => new Date() }) => {
  /**
   * GET /members/nearby?lat=..&lng=..&radius_m=2000
   * lat and lng are validated by the route; radius_m is clamped to 50..20000.
   */
  const getNearby = async (req, res) => {
    try {
      const latitude = Number(req.query.lat);
      const longitude = Number(req.query.lng);
      const radiusMeters = membership.clampRadius(req.query.radius_m);
      const box = membership.boundingBox(latitude, longitude, radiusMeters);
      // One range is sent twice, so the statement is the same either way.
      const [first, second = first] = box.lngRanges;
      const result = await query(NEARBY_SQL, [
        latitude, longitude,
        box.latMin, box.latMax,
        first[0], first[1], second[0], second[1],
        radiusMeters, membership.NEARBY_MAX_RESULTS,
      ]);
      const at = now();
      return success(res, { members: result.rows.map((row) => membership.publicMember(row, at)) });
    } catch (err) {
      console.error('Members nearby error:', err);
      return error(res, 'Failed to look up member businesses', 500);
    }
  };

  /** GET /members/tiers: the active tiers, in their display order. */
  const getTiers = async (req, res) => {
    try {
      const result = await query(ACTIVE_TIERS_SQL);
      return success(res, { tiers: result.rows.map(membership.publicTier) });
    } catch (err) {
      console.error('Membership tiers error:', err);
      return error(res, 'Failed to load membership tiers', 500);
    }
  };

  /**
   * Emails the team about a new application. Never throws and is not awaited
   * by the request: the application is already saved, and a mail server that
   * is slow or down must not fail or delay the business's answer. Only the
   * application id and the mailer's message are logged, never what the
   * business typed.
   */
  const deliverNotice = async ({ application, tier, settingsContactEmail }) => {
    try {
      if (!isEmailConfigured()) return false;
      const toEmail = optionalText(settingsContactEmail) || optionalText(adminContactEmail());
      if (!toEmail) {
        console.warn(`Membership application ${application.id}: no contact email is set, so no notice was sent`);
        return false;
      }
      await sendNotice({ toEmail, application, tier });
      return true;
    } catch (err) {
      console.error(`Membership application email failed (application ${application.id}):`, err.message);
      return false;
    }
  };

  /**
   * POST /members/apply, from the public /membership page. The body is
   * validated by the route. The tier, and so the fee quoted, is chosen here
   * from employee_count; a tier picked by the form is never trusted.
   */
  const apply = async (req, res) => {
    const b = req.body;
    try {
      const employeeCount = Number(b.employee_count);
      const [tiers, settings] = await Promise.all([
        query(ACTIVE_TIERS_SQL),
        query('SELECT payment_instructions, contact_email FROM membership_settings WHERE id = TRUE'),
      ]);
      const tierRow = membership.selectTier(tiers.rows, employeeCount);
      const tier = tierRow ? membership.publicTier(tierRow) : null;

      const hasLocation = b.latitude !== undefined && b.latitude !== null && b.latitude !== '';
      const inserted = await query(
        `INSERT INTO membership_applications
           (business_name, contact_name, email, phone, address, category, employee_count,
            latitude, longitude, website, message, tier_id, quoted_fee)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id, created_at`,
        [
          String(b.business_name).trim(), String(b.contact_name).trim(), String(b.email).trim(),
          optionalText(b.phone), optionalText(b.address), optionalText(b.category), employeeCount,
          hasLocation ? Number(b.latitude) : null, hasLocation ? Number(b.longitude) : null,
          optionalText(b.website), optionalText(b.message),
          tier ? tier.id : null, tier ? tier.annual_fee : null,
        ]
      );

      const application = {
        id: inserted.rows[0].id,
        business_name: String(b.business_name).trim(),
        contact_name: String(b.contact_name).trim(),
        email: String(b.email).trim(),
        phone: optionalText(b.phone),
        address: optionalText(b.address),
        category: optionalText(b.category),
        employee_count: employeeCount,
        website: optionalText(b.website),
        message: optionalText(b.message),
      };
      const settingsRow = settings.rows[0] || {};

      created(res, {
        application_id: application.id,
        tier: tier
          ? { name: tier.name, annual_fee: tier.annual_fee, currency: tier.currency, is_provisional: tier.is_provisional }
          : null,
        payment_instructions: typeof settingsRow.payment_instructions === 'string' ? settingsRow.payment_instructions : '',
      }, 'Application received');

      deliverNotice({ application, tier, settingsContactEmail: settingsRow.contact_email });
      return undefined;
    } catch (err) {
      // The message and code only: a constraint error's detail repeats the
      // row, which is what the business typed.
      console.error('Membership application error:', err.message, err.code || '');
      return error(res, 'Failed to save your application. Please try again.', 500);
    }
  };

  return { getNearby, getTiers, apply, deliverNotice };
};

/**
 * Mounted ahead of validation on POST /members/apply. When the hidden
 * HONEYPOT_FIELD is filled, answers 201 in the usual shape and stops: no row,
 * no email, and nothing logged that the sender typed. Bots get no sign they
 * were spotted, so they do not adapt.
 */
const dropBotApplication = (req, res, next) => {
  const trap = req.body ? req.body[HONEYPOT_FIELD] : undefined;
  if (trap === undefined || trap === null || trap === '') return next();
  console.warn('Membership application dropped: the hidden field was filled');
  return created(res, {
    application_id: crypto.randomUUID(),
    tier: null,
    payment_instructions: '',
  }, 'Application received');
};

const { getNearby, getTiers, apply } = buildMembershipHandlers({
  query: db.query,
  sendNotice: emailService.sendMembershipApplicationNotice,
  isEmailConfigured: emailService.isEmailConfigured,
  adminContactEmail: () => process.env.ADMIN_EMAIL,
});

module.exports = {
  buildMembershipHandlers, getNearby, getTiers, apply, dropBotApplication, HONEYPOT_FIELD, NEARBY_SQL, ACTIVE_TIERS_SQL,
};
