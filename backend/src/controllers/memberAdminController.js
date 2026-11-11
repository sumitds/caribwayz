const db = require('../config/db');
const membership = require('../services/membership');
const { success, created, error, notFound } = require('../utils/response');

// Postgres error codes the admin can cause with a valid-looking request.
const NOT_NULL_VIOLATION = '23502';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

/** Fields an admin may set on a business, in column order. */
const BUSINESS_FIELDS = [
  'name', 'category', 'latitude', 'longitude', 'address', 'phone', 'website', 'description', 'image_url',
  'is_active', 'membership_tier', 'business_size', 'tier_id', 'employee_count', 'contact_email',
  'membership_status', 'membership_expires_at', 'promo_text', 'promo_expires_at',
  'registered_name', 'business_email', 'contact_name', 'contact_position', 'contact_phone',
];

const TIER_FIELDS = [
  'name', 'min_employees', 'max_employees', 'annual_fee', 'currency', 'is_provisional', 'sort_order', 'is_active',
];

const BUSINESS_SELECT = `SELECT b.*, t.name AS tier_name
   FROM businesses b
   LEFT JOIN membership_tiers t ON t.id = b.tier_id`;

// business_status is the linked listing's membership_status, so the panel can
// say a renewal waits for a suspension to be lifted.
const APPLICATION_SELECT = `SELECT a.*, t.name AS tier_name, t.currency AS tier_currency,
        lb.membership_status AS business_status
   FROM membership_applications a
   LEFT JOIN membership_tiers t ON t.id = a.tier_id
   LEFT JOIN businesses lb ON lb.id = a.business_id`;

/** An empty string from a form clears a text or date column. */
const blankToNull = (value) => (typeof value === 'string' && value.trim() === '' ? null : value);

/**
 * The SET clause and parameters for the [fields] present in [body], numbered
 * from $1. Only fields the caller sent are touched, so PATCH can clear one
 * (send null) without the others changing.
 */
const assignments = (fields, body) => {
  const sets = [];
  const params = [];
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      params.push(blankToNull(body[field]));
      sets.push(`${field} = $${params.length}`);
    }
  }
  return { sets, params };
};

/** A refused write the admin can fix: a missing tier, or a rule in the schema. */
const writeRefusal = (err) => {
  if (err.code === FOREIGN_KEY_VIOLATION) return 'That membership tier does not exist';
  if (err.code === NOT_NULL_VIOLATION) return `${err.column || 'A required field'} cannot be empty`;
  if (err.code === CHECK_VIOLATION) {
    // The table-level rule of migration 025: max_employees >= min_employees.
    if (err.constraint === 'membership_tiers_check') return 'Maximum employees must be at least the minimum';
    return 'One of the values is not allowed';
  }
  return null;
};

/**
 * Builds the admin handlers with their dependencies passed in, so tests can
 * supply a fake query and transaction client. The module exports a set wired
 * to the real database.
 */
const buildMemberAdminHandlers = ({ query, getClient }) => {
  // Businesses

  /** GET /admin/businesses?membership_status=&is_active=true|false */
  const getBusinesses = async (req, res) => {
    try {
      const params = [];
      let sql = `${BUSINESS_SELECT} WHERE 1=1`;
      if (req.query.membership_status) {
        params.push(req.query.membership_status);
        sql += ` AND b.membership_status = $${params.length}`;
      }
      if (req.query.is_active === 'true' || req.query.is_active === 'false') {
        params.push(req.query.is_active === 'true');
        sql += ` AND b.is_active = $${params.length}`;
      }
      sql += ' ORDER BY b.created_at DESC';
      const result = await query(sql, params);
      return success(res, { businesses: result.rows.map(membership.adminBusiness) });
    } catch (err) {
      console.error('Get businesses error:', err);
      return error(res, 'Failed to fetch businesses', 500);
    }
  };

  /** POST /admin/businesses. The body is validated by the route. */
  const addBusiness = async (req, res) => {
    try {
      const body = { membership_status: 'pending', ...req.body };
      const { sets, params } = assignments(BUSINESS_FIELDS, body);
      const columns = sets.map((s) => s.split(' = ')[0]);
      params.push(req.user.id);
      const result = await query(
        `INSERT INTO businesses (${columns.join(', ')}, created_by)
         VALUES (${params.map((_, i) => `$${i + 1}`).join(', ')})
         RETURNING id`,
        params
      );
      const row = await query(`${BUSINESS_SELECT} WHERE b.id = $1`, [result.rows[0].id]);
      return created(res, { business: membership.adminBusiness(row.rows[0]) }, 'Business added');
    } catch (err) {
      const refusal = writeRefusal(err);
      if (refusal) return error(res, refusal, 400);
      console.error('Add business error:', err);
      return error(res, 'Failed to add business', 500);
    }
  };

  /** PATCH /admin/businesses/:id with any subset of BUSINESS_FIELDS. */
  const updateBusiness = async (req, res) => {
    try {
      const { sets, params } = assignments(BUSINESS_FIELDS, req.body);
      if (sets.length === 0) return error(res, 'Nothing to update', 400);
      params.push(req.params.id);
      const result = await query(
        `UPDATE businesses SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING id`,
        params
      );
      if (result.rows.length === 0) return notFound(res, 'Business not found');
      const row = await query(`${BUSINESS_SELECT} WHERE b.id = $1`, [req.params.id]);
      return success(res, { business: membership.adminBusiness(row.rows[0]) }, 'Business updated');
    } catch (err) {
      const refusal = writeRefusal(err);
      if (refusal) return error(res, refusal, 400);
      console.error('Update business error:', err);
      return error(res, 'Failed to update business', 500);
    }
  };

  // Tiers

  /** GET /admin/membership-tiers: every tier, inactive ones too. */
  const getTiers = async (req, res) => {
    try {
      const result = await query('SELECT * FROM membership_tiers ORDER BY sort_order NULLS LAST, min_employees, id');
      return success(res, { tiers: result.rows.map(membership.adminTier) });
    } catch (err) {
      console.error('Get membership tiers error:', err);
      return error(res, 'Failed to fetch membership tiers', 500);
    }
  };

  /** POST /admin/membership-tiers. The body is validated by the route. */
  const addTier = async (req, res) => {
    try {
      const body = { currency: 'USD', is_provisional: false, is_active: true, ...req.body };
      const { sets, params } = assignments(TIER_FIELDS, body);
      const columns = sets.map((s) => s.split(' = ')[0]);
      const result = await query(
        `INSERT INTO membership_tiers (${columns.join(', ')})
         VALUES (${params.map((_, i) => `$${i + 1}`).join(', ')})
         RETURNING *`,
        params
      );
      return created(res, { tier: membership.adminTier(result.rows[0]) }, 'Tier added');
    } catch (err) {
      const refusal = writeRefusal(err);
      if (refusal) return error(res, refusal, 400);
      console.error('Add membership tier error:', err);
      return error(res, 'Failed to add membership tier', 500);
    }
  };

  /** PATCH /admin/membership-tiers/:id with any subset of TIER_FIELDS. */
  const updateTier = async (req, res) => {
    try {
      const { sets, params } = assignments(TIER_FIELDS, req.body);
      if (sets.length === 0) return error(res, 'Nothing to update', 400);
      params.push(req.params.id);
      const result = await query(
        `UPDATE membership_tiers SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
        params
      );
      if (result.rows.length === 0) return notFound(res, 'Tier not found');
      return success(res, { tier: membership.adminTier(result.rows[0]) }, 'Tier updated');
    } catch (err) {
      const refusal = writeRefusal(err);
      if (refusal) return error(res, refusal, 400);
      console.error('Update membership tier error:', err);
      return error(res, 'Failed to update membership tier', 500);
    }
  };

  // Applications

  /** GET /admin/membership-applications?status=, newest first, with a count per status. */
  const getApplications = async (req, res) => {
    try {
      const params = [];
      let sql = `${APPLICATION_SELECT} WHERE 1=1`;
      if (req.query.status) {
        params.push(req.query.status);
        sql += ` AND a.status = $${params.length}`;
      }
      sql += ' ORDER BY a.created_at DESC';
      const [result, counts] = await Promise.all([
        query(sql, params),
        query('SELECT status, COUNT(*) FROM membership_applications GROUP BY status'),
      ]);
      const summary = {};
      membership.APPLICATION_STATUSES.forEach((s) => { summary[s] = 0; });
      counts.rows.forEach((r) => { summary[r.status] = parseInt(r.count, 10); });
      return success(res, { applications: result.rows.map(membership.adminApplication), summary });
    } catch (err) {
      console.error('Get membership applications error:', err);
      return error(res, 'Failed to fetch membership applications', 500);
    }
  };

  /** PATCH /admin/membership-applications/:id with status and/or admin_notes. */
  const updateApplication = async (req, res) => {
    try {
      const { sets, params } = assignments(['status', 'admin_notes'], req.body);
      if (sets.length === 0) return error(res, 'Nothing to update', 400);
      params.push(req.params.id);
      const result = await query(
        `UPDATE membership_applications SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING id`,
        params
      );
      if (result.rows.length === 0) return notFound(res, 'Application not found');
      const row = await query(`${APPLICATION_SELECT} WHERE a.id = $1`, [req.params.id]);
      return success(res, { application: membership.adminApplication(row.rows[0]) }, 'Application updated');
    } catch (err) {
      const refusal = writeRefusal(err);
      if (refusal) return error(res, refusal, 400);
      console.error('Update membership application error:', err);
      return error(res, 'Failed to update membership application', 500);
    }
  };

  /**
   * POST /admin/membership-applications/:id/activate { latitude, longitude, months = 12 }
   *
   * Once the business has paid: creates its member listing from the
   * application, active until now + months, or renews the one already
   * linked: from its current expiry when that is still ahead, so paid time is
   * kept, otherwise from now. Then marks the application paid and links it.
   * A rejected application is refused (409) until an admin reopens it, and so
   * is renewing a suspended listing until an admin lifts the suspension: a
   * payment must not quietly undo a suspension. One transaction, so a
   * failure halfway leaves neither a listing without a paid application nor
   * the reverse. The location may be left out when the application, or the
   * linked listing, already has one.
   */
  const activateApplication = async (req, res) => {
    const months = req.body.months === undefined || req.body.months === null ? 12 : Number(req.body.months);
    const hasLocation = req.body.latitude !== undefined && req.body.latitude !== null;
    const latitude = hasLocation ? Number(req.body.latitude) : null;
    const longitude = hasLocation ? Number(req.body.longitude) : null;

    let client;
    try {
      client = await getClient();
    } catch (err) {
      console.error('Activate membership: no database connection:', err);
      return error(res, 'Failed to activate the membership', 500);
    }

    try {
      await client.query('BEGIN');
      const found = await client.query('SELECT * FROM membership_applications WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (found.rows.length === 0) {
        await client.query('ROLLBACK');
        return notFound(res, 'Application not found');
      }
      const application = found.rows[0];
      if (application.status === 'rejected') {
        await client.query('ROLLBACK');
        return error(res, 'This application was rejected. Reopen it before activating the membership.', 409);
      }

      let linked = null;
      if (application.business_id) {
        const existing = await client.query('SELECT id, membership_status FROM businesses WHERE id = $1 FOR UPDATE', [application.business_id]);
        linked = existing.rows[0] || null;
      }
      if (linked && linked.membership_status === 'suspended') {
        await client.query('ROLLBACK');
        return error(res, 'This business is suspended. Lift the suspension on the Member Businesses page before renewing it.', 409);
      }

      let businessId;
      if (linked) {
        const updated = await client.query(
          `UPDATE businesses SET
             membership_status = 'active',
             membership_expires_at = CASE
               WHEN membership_expires_at > NOW() THEN membership_expires_at
               ELSE NOW()
             END + make_interval(months => $1),
             is_active = TRUE,
             latitude = COALESCE($2, latitude),
             longitude = COALESCE($3, longitude),
             tier_id = COALESCE($4, tier_id),
             updated_at = NOW()
           WHERE id = $5 RETURNING id`,
          [months, latitude, longitude, application.tier_id, linked.id]
        );
        businessId = updated.rows[0].id;
      } else {
        const lat = hasLocation ? latitude : membership.toNumberOrNull(application.latitude);
        const lng = hasLocation ? longitude : membership.toNumberOrNull(application.longitude);
        if (lat === null || lng === null) {
          await client.query('ROLLBACK');
          return error(res, 'This application has no location. Give the latitude and longitude of the business.', 400);
        }
        // The app shows the trading name when the business gave one; the
        // registered name is kept beside it.
        const shownName = membership.listingName(application);
        const inserted = await client.query(
          `INSERT INTO businesses
             (name, category, latitude, longitude, address, phone, website, tier_id, employee_count, contact_email,
              membership_status, membership_expires_at, is_active, created_by,
              registered_name, description, business_email, contact_name, contact_position, contact_phone)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
              'active', NOW() + make_interval(months => $11), TRUE, $12,
              $13, $14, $15, $16, $17, $18)
           RETURNING id`,
          [shownName, application.category, lat, lng, application.address, application.phone,
           application.website, application.tier_id, application.employee_count, application.email,
           months, req.user.id,
           application.business_name, application.description ?? null, application.business_email ?? null,
           application.contact_name, application.contact_position ?? null, application.contact_phone ?? null]
        );
        businessId = inserted.rows[0].id;
      }

      await client.query(
        `UPDATE membership_applications SET status = 'paid', business_id = $1, updated_at = NOW() WHERE id = $2`,
        [businessId, application.id]
      );
      await client.query('COMMIT');

      const [business, updatedApplication] = await Promise.all([
        query(`${BUSINESS_SELECT} WHERE b.id = $1`, [businessId]),
        query(`${APPLICATION_SELECT} WHERE a.id = $1`, [application.id]),
      ]);
      return success(res, {
        business: membership.adminBusiness(business.rows[0]),
        application: membership.adminApplication(updatedApplication.rows[0]),
      }, linked ? 'Membership renewed' : 'Membership activated');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Activate membership rollback error:', rollbackErr.message);
      }
      const refusal = writeRefusal(err);
      if (refusal) return error(res, refusal, 400);
      console.error('Activate membership error:', err);
      return error(res, 'Failed to activate the membership', 500);
    } finally {
      client.release();
    }
  };

  // Settings

  const readSettings = async () => {
    const result = await query('SELECT payment_instructions, contact_email, updated_at FROM membership_settings WHERE id = TRUE');
    return result.rows[0] || { payment_instructions: '', contact_email: null, updated_at: null };
  };

  /** GET /admin/membership-settings */
  const getSettings = async (req, res) => {
    try {
      return success(res, { settings: await readSettings() });
    } catch (err) {
      console.error('Get membership settings error:', err);
      return error(res, 'Failed to fetch membership settings', 500);
    }
  };

  /**
   * PUT /admin/membership-settings { payment_instructions, contact_email }.
   * A field left out keeps its value; contact_email '' or null clears it.
   */
  const updateSettings = async (req, res) => {
    try {
      const has = (field) => Object.prototype.hasOwnProperty.call(req.body, field);
      const instructions = has('payment_instructions') ? (req.body.payment_instructions ?? '') : null;
      const contactEmail = has('contact_email') ? blankToNull(req.body.contact_email) : null;
      const result = await query(
        `INSERT INTO membership_settings (id, payment_instructions, contact_email, updated_at)
         VALUES (TRUE, COALESCE($1, ''), $2, NOW())
         ON CONFLICT (id) DO UPDATE SET
           payment_instructions = CASE WHEN $3 THEN COALESCE($1, '') ELSE membership_settings.payment_instructions END,
           contact_email = CASE WHEN $4 THEN $2 ELSE membership_settings.contact_email END,
           updated_at = NOW()
         RETURNING payment_instructions, contact_email, updated_at`,
        [instructions, contactEmail, has('payment_instructions'), has('contact_email')]
      );
      return success(res, { settings: result.rows[0] }, 'Membership settings saved');
    } catch (err) {
      console.error('Update membership settings error:', err);
      return error(res, 'Failed to save membership settings', 500);
    }
  };

  return {
    getBusinesses, addBusiness, updateBusiness,
    getTiers, addTier, updateTier,
    getApplications, updateApplication, activateApplication,
    getSettings, updateSettings,
  };
};

const handlers = buildMemberAdminHandlers({ query: db.query, getClient: db.getClient });

module.exports = { buildMemberAdminHandlers, BUSINESS_FIELDS, TIER_FIELDS, ...handlers };
