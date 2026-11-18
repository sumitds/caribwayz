const db = require('../config/db');
const emailService = require('../services/emailService');
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
  'is_featured', 'featured_until',
];

/** Fields an admin may change on a campaign (migration 034); business_id is fixed once entered. */
const CAMPAIGN_FIELDS = ['kind', 'offer_text', 'start_date', 'end_date'];

/** The longest a campaign may run, in days, so a mistyped year is caught. */
const CAMPAIGN_MAX_DAYS = 366;

const TIER_FIELDS = [
  'name', 'min_employees', 'max_employees', 'annual_fee', 'currency', 'is_provisional', 'sort_order', 'is_active',
];

// featured_now (migration 034): featured today in Jamaica and shown in the
// app, the rule GET /members/nearby lists featured members first by.
const BUSINESS_SELECT = `SELECT b.*, t.name AS tier_name,
        COALESCE(b.is_featured AND b.featured_until >= ${membership.JAMAICA_TODAY_SQL}
          AND b.is_active = TRUE AND b.membership_status = 'active'
          AND (b.membership_expires_at IS NULL OR b.membership_expires_at > NOW()), FALSE) AS featured_now,
        ru.name AS last_reminder_sent_by_name
   FROM businesses b
   LEFT JOIN membership_tiers t ON t.id = b.tier_id
   LEFT JOIN users ru ON ru.id = b.last_reminder_sent_by`;

const CAMPAIGN_SELECT = `SELECT c.*, b.name AS business_name, u.name AS created_by_name
   FROM member_campaigns c
   JOIN businesses b ON b.id = c.business_id
   LEFT JOIN users u ON u.id = c.created_by`;

/** A membership as the renewal reminders list shows it. */
const RENEWAL_SELECT = `SELECT b.id, b.name, b.membership_status, b.membership_expires_at, b.contact_email, b.business_email,
        b.contact_name, b.last_reminder_sent_at, t.name AS tier_name, ru.name AS last_reminder_sent_by_name
   FROM businesses b
   LEFT JOIN membership_tiers t ON t.id = b.tier_id
   LEFT JOIN users ru ON ru.id = b.last_reminder_sent_by`;

/** The statuses a renewal reminder can be sent for. */
const REMINDABLE_STATUSES = ['active', 'expired'];

// The memberships the renewal reminders list shows: active or expired, with
// an end within $1 days either side of now. Pending, suspended and cancelled
// memberships are left out: there is nothing for them to renew yet.
const RENEWALS_SQL = `${RENEWAL_SELECT}
  WHERE b.membership_status IN ('active', 'expired')
    AND b.membership_expires_at IS NOT NULL
    AND b.membership_expires_at > NOW() - make_interval(days => $1)
    AND b.membership_expires_at <= NOW() + make_interval(days => $1)
  ORDER BY b.membership_expires_at, b.id`;

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
    if (err.constraint === 'businesses_featured_until_check') return 'Give the date the featured placement ends';
    return 'One of the values is not allowed';
  }
  return null;
};

/**
 * Builds the admin handlers with their dependencies passed in, so tests can
 * supply a fake query and transaction client. The module exports a set wired
 * to the real database.
 */
const buildMemberAdminHandlers = ({
  query, getClient, now = () => new Date(), isEmailConfigured, sendRenewalReminder, adminContactEmail = () => undefined,
}) => {
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
      // Featured members first, as the app lists them (migration 034).
      sql += ' ORDER BY featured_now DESC, b.created_at DESC';
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

  // Campaigns (migration 034)

  /** A refused campaign write the admin can fix, or null. */
  const campaignRefusal = (err) => {
    if (err.code === FOREIGN_KEY_VIOLATION && err.constraint === 'member_campaigns_business_fkey') return 'That business does not exist';
    if (err.code === CHECK_VIOLATION && err.constraint === 'member_campaigns_dates_check') return 'The end date must be on or after the start date';
    if (err.code === CHECK_VIOLATION && err.constraint === 'member_campaigns_offer_check') return 'The offer text is required';
    if (err.code === CHECK_VIOLATION) return 'One of the values is not allowed';
    return null;
  };

  /** Why [startDate]..[endDate] (YYYY-MM-DD) cannot be a campaign, or null. */
  const datesRefusal = (startDate, endDate) => {
    if (endDate < startDate) return 'The end date must be on or after the start date';
    if (membership.daysBetween(startDate, endDate) + 1 > CAMPAIGN_MAX_DAYS) {
      return `A campaign can run at most ${CAMPAIGN_MAX_DAYS} days`;
    }
    return null;
  };

  /**
   * GET /admin/membership-campaigns?business_id=&state=
   * Newest start first. Each says where it stands today in Jamaica, and
   * in_use marks the one the app speaks for its business now.
   */
  const getCampaigns = async (req, res) => {
    try {
      const params = [];
      let sql = `${CAMPAIGN_SELECT} WHERE 1=1`;
      if (req.query.business_id) {
        params.push(req.query.business_id);
        sql += ` AND c.business_id = $${params.length}`;
      }
      sql += ' ORDER BY c.start_date DESC, c.created_at DESC, c.id DESC';
      const result = await query(sql, params);
      const today = membership.jamaicaDay(now());
      const byBusiness = new Map();
      for (const row of result.rows) {
        if (!byBusiness.has(row.business_id)) byBusiness.set(row.business_id, []);
        byBusiness.get(row.business_id).push(row);
      }
      const inUse = new Set();
      for (const rows of byBusiness.values()) {
        const picked = membership.pickCampaign(rows, today);
        if (picked) inUse.add(picked.id);
      }
      let campaigns = result.rows.map((row) => membership.adminCampaign(row, today, inUse.has(row.id)));
      if (req.query.state) campaigns = campaigns.filter((c) => c.state === req.query.state);
      return success(res, { campaigns, today });
    } catch (err) {
      console.error('Get member campaigns error:', err);
      return error(res, 'Failed to fetch campaigns', 500);
    }
  };

  const campaignById = async (id) => {
    const row = await query(`${CAMPAIGN_SELECT} WHERE c.id = $1`, [id]);
    return row.rows[0] || null;
  };

  /** Answers with the campaign as it now stands. */
  const campaignAnswer = async (res, id, message, status = 200) => {
    const row = await campaignById(id);
    if (!row) return notFound(res, 'Campaign not found');
    const campaign = membership.adminCampaign(row, membership.jamaicaDay(now()));
    return status === 201 ? created(res, { campaign }, message) : success(res, { campaign }, message);
  };

  /**
   * POST /admin/membership-campaigns { business_id, kind, offer_text, start_date, end_date }.
   * The body is validated by the route. A campaign that would already be over
   * (its end before today in Jamaica) is refused: it would never be heard.
   */
  const addCampaign = async (req, res) => {
    try {
      const b = req.body;
      const refusal = datesRefusal(b.start_date, b.end_date);
      if (refusal) return error(res, refusal, 400);
      if (b.end_date < membership.jamaicaDay(now())) {
        return error(res, 'This campaign would already be over. Give an end date from today on.', 400);
      }
      const inserted = await query(
        `INSERT INTO member_campaigns (business_id, kind, offer_text, start_date, end_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [b.business_id, b.kind, String(b.offer_text).trim(), b.start_date, b.end_date, req.user.id]
      );
      return await campaignAnswer(res, inserted.rows[0].id, 'Campaign added', 201);
    } catch (err) {
      const refusal = campaignRefusal(err);
      if (refusal) return error(res, refusal, 400);
      console.error('Add member campaign error:', err);
      return error(res, 'Failed to add the campaign', 500);
    }
  };

  /** PATCH /admin/membership-campaigns/:id with any of kind, offer_text, start_date, end_date. */
  const updateCampaign = async (req, res) => {
    try {
      const body = { ...req.body };
      if (typeof body.offer_text === 'string') body.offer_text = body.offer_text.trim();
      const { sets, params } = assignments(CAMPAIGN_FIELDS, body);
      if (sets.length === 0) return error(res, 'Nothing to update', 400);
      const existing = await campaignById(req.params.id);
      if (!existing) return notFound(res, 'Campaign not found');
      const startDate = body.start_date ?? membership.calendarDate(existing.start_date);
      const endDate = body.end_date ?? membership.calendarDate(existing.end_date);
      const refusal = datesRefusal(startDate, endDate);
      if (refusal) return error(res, refusal, 400);
      params.push(req.params.id);
      const result = await query(
        `UPDATE member_campaigns SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING id`,
        params
      );
      if (result.rows.length === 0) return notFound(res, 'Campaign not found');
      return await campaignAnswer(res, req.params.id, 'Campaign updated');
    } catch (err) {
      const refusal = campaignRefusal(err);
      if (refusal) return error(res, refusal, 400);
      console.error('Update member campaign error:', err);
      return error(res, 'Failed to update the campaign', 500);
    }
  };

  /**
   * POST /admin/membership-campaigns/:id/end: stops it now, keeping its dates
   * as the record of what was sold. Ending one already ended is a 409.
   */
  const endCampaign = async (req, res) => {
    try {
      const result = await query(
        'UPDATE member_campaigns SET ended_at = NOW(), updated_at = NOW() WHERE id = $1 AND ended_at IS NULL RETURNING id',
        [req.params.id]
      );
      if (result.rows.length === 0) {
        const existing = await campaignById(req.params.id);
        if (!existing) return notFound(res, 'Campaign not found');
        return error(res, 'This campaign has already been ended', 409);
      }
      return await campaignAnswer(res, req.params.id, 'Campaign ended');
    } catch (err) {
      console.error('End member campaign error:', err);
      return error(res, 'Failed to end the campaign', 500);
    }
  };

  /** DELETE /admin/membership-campaigns/:id */
  const deleteCampaign = async (req, res) => {
    try {
      const result = await query('DELETE FROM member_campaigns WHERE id = $1 RETURNING id', [req.params.id]);
      if (result.rows.length === 0) return notFound(res, 'Campaign not found');
      return success(res, { id: req.params.id }, 'Campaign deleted');
    } catch (err) {
      console.error('Delete member campaign error:', err);
      return error(res, 'Failed to delete the campaign', 500);
    }
  };

  // Renewal reminders (migration 034)

  const emailReady = () => Boolean(isEmailConfigured && isEmailConfigured());

  /**
   * GET /admin/membership-renewals: active and expired memberships whose end
   * is within RENEWAL_WINDOW_DAYS of now, split into ending_soon (soonest
   * first) and recently_expired (most recently ended first).
   */
  const getRenewals = async (req, res) => {
    try {
      const result = await query(RENEWALS_SQL, [membership.RENEWAL_WINDOW_DAYS]);
      const at = now();
      const entries = result.rows.map((row) => membership.renewalEntry(row, at));
      return success(res, {
        window_days: membership.RENEWAL_WINDOW_DAYS,
        email_configured: emailReady(),
        ending_soon: entries.filter((e) => !e.expired),
        recently_expired: entries.filter((e) => e.expired).reverse(),
      });
    } catch (err) {
      console.error('Get membership renewals error:', err);
      return error(res, 'Failed to fetch the renewal reminders list', 500);
    }
  };

  /** The address replies to a reminder go to: the membership settings' contact, else ADMIN_EMAIL; null when neither. */
  const replyAddress = (settingsContactEmail) => {
    for (const value of [settingsContactEmail, adminContactEmail()]) {
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return null;
  };

  /**
   * POST /admin/membership-renewals/:id/remind { resend }
   *
   * Emails the business that its membership ends (or has ended) and records
   * when, and by whom. Only an admin's click sends one; there is no schedule.
   * A second reminder on the same day in Jamaica is refused (409) unless
   * resend is true, so a double click cannot send two. The business row is
   * locked while the email goes out, so two admins clicking at once send one.
   * Nothing is recorded when the mail server refuses it (502), and nothing is
   * tried when the server has no SMTP login (503).
   */
  const sendReminder = async (req, res) => {
    if (!emailReady()) {
      return error(res, 'Email is not set up on the server (SMTP), so reminders cannot be sent.', 503);
    }

    let client;
    try {
      client = await getClient();
    } catch (err) {
      console.error('Renewal reminder: no database connection:', err);
      return error(res, 'Failed to send the reminder', 500);
    }

    try {
      await client.query('BEGIN');
      const found = await client.query('SELECT * FROM businesses WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (found.rows.length === 0) {
        await client.query('ROLLBACK');
        return notFound(res, 'Business not found');
      }
      const business = found.rows[0];
      if (!REMINDABLE_STATUSES.includes(business.membership_status)) {
        await client.query('ROLLBACK');
        return error(res, `Reminders are for active or expired memberships; this one is ${business.membership_status}.`, 409);
      }
      if (!business.membership_expires_at) {
        await client.query('ROLLBACK');
        return error(res, 'This membership has no end date, so there is nothing to renew yet.', 400);
      }
      const toEmail = membership.reminderRecipient(business);
      if (!toEmail) {
        await client.query('ROLLBACK');
        return error(res, 'This business has no contact or business email. Add one on the Member Businesses page.', 400);
      }
      const at = now();
      const today = membership.jamaicaDay(at);
      const resend = req.body?.resend === true;
      if (!resend && business.last_reminder_sent_at && membership.jamaicaDay(new Date(business.last_reminder_sent_at)) === today) {
        await client.query('ROLLBACK');
        return error(res, 'A reminder was already sent to this business today. Confirm to send another.', 409);
      }

      const settings = await client.query('SELECT payment_instructions, contact_email FROM membership_settings WHERE id = TRUE');
      const settingsRow = settings.rows[0] || {};
      const expiresAt = new Date(business.membership_expires_at);

      try {
        await sendRenewalReminder({
          toEmail,
          businessName: business.name,
          expiresAt,
          expired: expiresAt.getTime() <= at.getTime(),
          contactEmail: replyAddress(settingsRow.contact_email),
          paymentInstructions: typeof settingsRow.payment_instructions === 'string' ? settingsRow.payment_instructions : '',
        });
      } catch (err) {
        await client.query('ROLLBACK');
        // The mailer's message only: never the address or the business's details.
        console.error(`Renewal reminder email failed (business ${business.id}):`, err.message);
        return error(res, 'The mail server did not accept the reminder. Nothing was recorded; try again later.', 502);
      }

      await client.query(
        'UPDATE businesses SET last_reminder_sent_at = $1, last_reminder_sent_by = $2 WHERE id = $3',
        [at, req.user.id, business.id]
      );
      await client.query('COMMIT');

      const row = await query(`${RENEWAL_SELECT} WHERE b.id = $1`, [business.id]);
      return success(res, { renewal: membership.renewalEntry(row.rows[0], at) }, `Reminder sent to ${toEmail}`);
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Renewal reminder rollback error:', rollbackErr.message);
      }
      console.error('Renewal reminder error:', err);
      return error(res, 'Failed to send the reminder', 500);
    } finally {
      client.release();
    }
  };

  return {
    getBusinesses, addBusiness, updateBusiness,
    getTiers, addTier, updateTier,
    getApplications, updateApplication, activateApplication,
    getSettings, updateSettings,
    getCampaigns, addCampaign, updateCampaign, endCampaign, deleteCampaign,
    getRenewals, sendReminder,
  };
};

const handlers = buildMemberAdminHandlers({
  query: db.query,
  getClient: db.getClient,
  // Looked up on each call, so tests can stand in for the mailer.
  isEmailConfigured: () => emailService.isEmailConfigured(),
  sendRenewalReminder: (args) => emailService.sendMembershipRenewalReminder(args),
  adminContactEmail: () => process.env.ADMIN_EMAIL,
});

module.exports = {
  buildMemberAdminHandlers, BUSINESS_FIELDS, TIER_FIELDS, CAMPAIGN_FIELDS, CAMPAIGN_MAX_DAYS, ...handlers,
};
