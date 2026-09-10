const { query } = require('../config/db');
const { success, created, error, notFound } = require('../utils/response');

const getUsers = async (req, res) => {
  try {
    const { limit = 50, offset = 0, status, search } = req.query;
    let sql = `SELECT id, name, email, phone, role, status, created_at FROM users WHERE 1=1`;
    const params = [];

    if (status) { params.push(status); sql += ` AND status = $${params.length}`; }
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length})`;
    }

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(sql, params);
    const countResult = await query('SELECT COUNT(*) FROM users');

    return success(res, { users: result.rows, total: parseInt(countResult.rows[0].count) });
  } catch (err) {
    console.error('Admin get users error:', err);
    return error(res, 'Failed to fetch users', 500);
  }
};

const updateUserStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const result = await query(
      `UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, email, status`,
      [status, id]
    );
    if (result.rows.length === 0) return notFound(res, 'User not found');
    return success(res, { user: result.rows[0] }, `User ${status}`);
  } catch (err) {
    console.error('Admin update user error:', err);
    return error(res, 'Failed to update user', 500);
  }
};

/**
 * Grants or revokes emergency-responder access.
 *
 * This is the only way users.is_responder can be set. Registration accepts a
 * self-declared user_type, so if that field granted access anyone could read
 * the live location of every person currently in an emergency; the approval
 * decision has to sit behind an admin.
 */
const updateResponderApproval = async (req, res) => {
  try {
    const { id } = req.params;
    const { approved } = req.body;

    if (typeof approved !== 'boolean') {
      return error(res, 'approved must be true or false', 400);
    }

    const result = await query(
      `UPDATE users
          SET is_responder = $1,
              responder_approved_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
              responder_approved_by = CASE WHEN $1 THEN $2::uuid ELSE NULL END,
              updated_at = NOW()
        WHERE id = $3
        RETURNING id, name, email, user_type, is_responder, responder_approved_at`,
      [approved, req.user.id, id]
    );

    if (result.rows.length === 0) return notFound(res, 'User not found');

    // Responder grants change who can read live emergency locations, so the
    // decision is written to the log with the admin who made it.
    console.log(
      `[Admin] ${req.user.id} set is_responder=${approved} on user ${id}`
    );

    return success(
      res,
      { user: result.rows[0] },
      approved ? 'Responder access granted' : 'Responder access revoked'
    );
  } catch (err) {
    console.error('Admin responder approval error:', err);
    return error(res, 'Failed to update responder access', 500);
  }
};

const getAllReports = async (req, res) => {
  try {
    const { limit = 100, offset = 0, status, type } = req.query;
    let sql = `SELECT r.*, u.name as reporter_name
               FROM reports r JOIN users u ON r.user_id = u.id WHERE 1=1`;
    const params = [];

    if (status) { params.push(status); sql += ` AND r.status = $${params.length}`; }
    if (type) { params.push(type); sql += ` AND r.type = $${params.length}`; }
    sql += ` ORDER BY r.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(sql, params);
    return success(res, { reports: result.rows });
  } catch (err) {
    console.error('Admin get reports error:', err);
    return error(res, 'Failed to fetch reports', 500);
  }
};

const removeReport = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(
      `UPDATE reports SET status = 'removed' WHERE id = $1 RETURNING id`,
      [id]
    );
    if (result.rows.length === 0) return notFound(res, 'Report not found');
    return success(res, {}, 'Report removed');
  } catch (err) {
    console.error('Admin remove report error:', err);
    return error(res, 'Failed to remove report', 500);
  }
};

const addBusiness = async (req, res) => {
  try {
    const { name, category, latitude, longitude, address, phone, website, description, membership_tier, business_size } = req.body;
    const result = await query(
      `INSERT INTO businesses (name, category, latitude, longitude, address, phone, website, description, membership_tier, business_size, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [name, category, latitude, longitude, address, phone, website, description,
       membership_tier || 'journey', business_size || 'small', req.user.id]
    );
    return created(res, { business: result.rows[0] }, 'Business added');
  } catch (err) {
    console.error('Add business error:', err);
    return error(res, 'Failed to add business', 500);
  }
};

const getBusinesses = async (req, res) => {
  try {
    const { tier, status } = req.query;
    let sql = `SELECT * FROM businesses WHERE 1=1`;
    const params = [];
    if (tier) { params.push(tier); sql += ` AND membership_tier = $${params.length}`; }
    if (status) { params.push(status === 'true'); sql += ` AND is_active = $${params.length}`; }
    sql += ` ORDER BY created_at DESC`;
    const result = await query(sql, params);
    return success(res, { businesses: result.rows });
  } catch (err) {
    console.error('Get businesses error:', err);
    return error(res, 'Failed to fetch businesses', 500);
  }
};

const updateBusiness = async (req, res) => {
  try {
    const { id } = req.params;
    const { membership_tier, business_size, membership_status, is_active } = req.body;
    const result = await query(
      `UPDATE businesses SET
         membership_tier = COALESCE($1, membership_tier),
         business_size = COALESCE($2, business_size),
         membership_status = COALESCE($3, membership_status),
         is_active = COALESCE($4, is_active)
       WHERE id = $5 RETURNING *`,
      [membership_tier, business_size, membership_status, is_active, id]
    );
    if (result.rows.length === 0) return notFound(res, 'Business not found');
    return success(res, { business: result.rows[0] }, 'Business updated');
  } catch (err) {
    console.error('Update business error:', err);
    return error(res, 'Failed to update business', 500);
  }
};

const getDashboardStats = async (req, res) => {
  try {
    const [users, routes, reports, emergencies, groups, businesses, broadcasts] = await Promise.all([
      query('SELECT COUNT(*) FROM users'),
      query('SELECT COUNT(*) FROM routes'),
      query("SELECT COUNT(*) FROM reports WHERE status = 'active'"),
      query("SELECT COUNT(*) FROM emergency_alerts WHERE status = 'active'"),
      query("SELECT COUNT(*) FROM groups"),
      query("SELECT COUNT(*) FROM businesses WHERE is_active = true"),
      query("SELECT COUNT(*) FROM broadcasts"),
    ]);

    const recentReports = await query(
      `SELECT type, COUNT(*) as count FROM reports WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY type ORDER BY count DESC LIMIT 5`
    );

    return success(res, {
      total_users: parseInt(users.rows[0].count),
      total_routes: parseInt(routes.rows[0].count),
      active_reports: parseInt(reports.rows[0].count),
      active_emergencies: parseInt(emergencies.rows[0].count),
      total_groups: parseInt(groups.rows[0].count),
      active_businesses: parseInt(businesses.rows[0].count),
      total_broadcasts: parseInt(broadcasts.rows[0].count),
      recent_report_types: recentReports.rows,
    });
  } catch (err) {
    console.error('Dashboard stats error:', err);
    return error(res, 'Failed to fetch stats', 500);
  }
};

// Broadcasts
const getBroadcasts = async (req, res) => {
  try {
    const result = await query(
      `SELECT b.*, u.name as sent_by FROM broadcasts b
       LEFT JOIN users u ON b.created_by = u.id
       ORDER BY b.created_at DESC LIMIT 100`
    );
    return success(res, { broadcasts: result.rows });
  } catch (err) {
    console.error('Get broadcasts error:', err);
    return error(res, 'Failed to fetch broadcasts', 500);
  }
};

const createBroadcast = async (req, res) => {
  try {
    const { title, message, type, scope, parish, severity } = req.body;
    const result = await query(
      `INSERT INTO broadcasts (title, message, type, scope, parish, severity, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [title, message, type, scope || 'island_wide', parish || null, severity || 'info', req.user.id]
    );
    return created(res, { broadcast: result.rows[0] }, 'Alert broadcast sent');
  } catch (err) {
    console.error('Create broadcast error:', err);
    return error(res, 'Failed to send broadcast', 500);
  }
};

const deleteBroadcast = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query('DELETE FROM broadcasts WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return notFound(res, 'Broadcast not found');
    return success(res, {}, 'Broadcast deleted');
  } catch (err) {
    console.error('Delete broadcast error:', err);
    return error(res, 'Failed to delete broadcast', 500);
  }
};

// Partners
const getPartners = async (req, res) => {
  try {
    const { tier, status } = req.query;
    let sql = `SELECT * FROM partners WHERE 1=1`;
    const params = [];
    if (tier) { params.push(tier); sql += ` AND tier = $${params.length}`; }
    if (status) { params.push(status); sql += ` AND status = $${params.length}`; }
    sql += ` ORDER BY created_at DESC`;
    const result = await query(sql, params);
    return success(res, { partners: result.rows });
  } catch (err) {
    console.error('Get partners error:', err);
    return error(res, 'Failed to fetch partners', 500);
  }
};

const addPartner = async (req, res) => {
  try {
    const { name, entity_type, tier, coverage, contact_name, contact_email, contact_phone, notes } = req.body;
    const result = await query(
      `INSERT INTO partners (name, entity_type, tier, coverage, contact_name, contact_email, contact_phone, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, entity_type, tier, coverage || 'local', contact_name, contact_email, contact_phone, notes]
    );
    return created(res, { partner: result.rows[0] }, 'Partner added');
  } catch (err) {
    console.error('Add partner error:', err);
    return error(res, 'Failed to add partner', 500);
  }
};

const updatePartnerStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const result = await query(
      `UPDATE partners SET status = $1 WHERE id = $2 RETURNING *`,
      [status, id]
    );
    if (result.rows.length === 0) return notFound(res, 'Partner not found');
    return success(res, { partner: result.rows[0] }, 'Partner updated');
  } catch (err) {
    console.error('Update partner error:', err);
    return error(res, 'Failed to update partner', 500);
  }
};

// Sponsorships
const getSponsorships = async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `SELECT s.*, u.name as user_name, u.email as user_email
               FROM sponsorships s LEFT JOIN users u ON s.user_id = u.id WHERE 1=1`;
    const params = [];
    if (status) { params.push(status); sql += ` AND s.status = $${params.length}`; }
    sql += ` ORDER BY s.created_at DESC`;
    const result = await query(sql, params);
    const counts = await query(`SELECT status, COUNT(*) FROM sponsorships GROUP BY status`);
    const summary = {};
    counts.rows.forEach(r => { summary[r.status] = parseInt(r.count); });
    return success(res, { sponsorships: result.rows, summary });
  } catch (err) {
    console.error('Get sponsorships error:', err);
    return error(res, 'Failed to fetch sponsorships', 500);
  }
};

const updateSponsorshipStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, starts_at, expires_at, notes } = req.body;
    const result = await query(
      `UPDATE sponsorships SET
         status = COALESCE($1, status),
         starts_at = COALESCE($2::timestamptz, starts_at),
         expires_at = COALESCE($3::timestamptz, expires_at),
         notes = COALESCE($4, notes),
         updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [status, starts_at || null, expires_at || null, notes || null, id]
    );
    if (result.rows.length === 0) return notFound(res, 'Sponsorship not found');
    return success(res, { sponsorship: result.rows[0] }, 'Sponsorship updated');
  } catch (err) {
    console.error('Update sponsorship error:', err);
    return error(res, 'Failed to update sponsorship', 500);
  }
};

// Payouts
const getPayouts = async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `SELECT p.*, u.name as user_name, u.email as user_email,
                      a.name as processed_by_name
               FROM payouts p
               LEFT JOIN users u ON p.user_id = u.id
               LEFT JOIN users a ON p.processed_by = a.id
               WHERE 1=1`;
    const params = [];
    if (status) { params.push(status); sql += ` AND p.status = $${params.length}`; }
    sql += ` ORDER BY p.requested_at DESC`;
    const result = await query(sql, params);
    const totals = await query(`SELECT status, COUNT(*), SUM(amount) FROM payouts GROUP BY status`);
    const summary = {};
    totals.rows.forEach(r => { summary[r.status] = { count: parseInt(r.count), total: parseFloat(r.sum || 0) }; });
    return success(res, { payouts: result.rows, summary });
  } catch (err) {
    console.error('Get payouts error:', err);
    return error(res, 'Failed to fetch payouts', 500);
  }
};

const updatePayoutStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, note } = req.body;
    const processed_at = (status === 'paid' || status === 'rejected') ? 'NOW()' : null;
    const result = await query(
      `UPDATE payouts SET
         status = $1,
         note = COALESCE($2, note),
         processed_by = $3,
         processed_at = ${processed_at ? 'NOW()' : 'processed_at'}
       WHERE id = $4 RETURNING *`,
      [status, note || null, req.user.id, id]
    );
    if (result.rows.length === 0) return notFound(res, 'Payout not found');
    return success(res, { payout: result.rows[0] }, `Payout marked as ${status}`);
  } catch (err) {
    console.error('Update payout error:', err);
    return error(res, 'Failed to update payout', 500);
  }
};

module.exports = {
  getUsers, updateUserStatus, updateResponderApproval, getAllReports, removeReport,
  addBusiness, getBusinesses, updateBusiness, getDashboardStats,
  getBroadcasts, createBroadcast, deleteBroadcast,
  getPartners, addPartner, updatePartnerStatus,
  getSponsorships, updateSponsorshipStatus,
  getPayouts, updatePayoutStatus,
};
