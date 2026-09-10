const { verifyToken } = require('../utils/jwt');
const { query } = require('../config/db');
const { unauthorized, forbidden, error } = require('../utils/response');

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return unauthorized(res, 'Access token is required');
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = verifyToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    return unauthorized(res, 'Invalid or expired token');
  }
};

const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return forbidden(res, 'Admin access required');
  }
  next();
};

/**
 * Decides whether a user may read live emergency alerts.
 *
 * Authorization is read from the database on every request rather than from the
 * token, for two reasons. The signed token carries only { id, email, role }, so
 * it cannot answer this at all. And these rows are the live locations of people
 * in trouble: revoking an account must take effect immediately, not whenever a
 * seven-day token happens to expire.
 *
 * The principal is users.is_responder, which only an admin can set. It is
 * deliberately NOT users.user_type: that field is supplied by the caller at
 * unauthenticated registration, so trusting it would let anyone grant
 * themselves access to every active emergency.
 *
 * Returns { allowed, reason }. Throws only if the database is unreachable, and
 * callers must fail closed on that.
 */
const resolveResponderAccess = async (userId) => {
  const result = await query(
    'SELECT role, user_type, status, is_responder FROM users WHERE id = $1',
    [userId]
  );

  if (result.rows.length === 0) {
    // The account behind a still-valid token was deleted.
    return { allowed: false, reason: 'Responder access required' };
  }

  const user = result.rows[0];

  // Checked for admins too. Previously the admin branch short-circuited on the
  // token's role claim and never looked at status, so a suspended admin kept
  // reading live locations until their token expired.
  if (user.status !== 'active') {
    return { allowed: false, reason: 'This account is not active' };
  }

  if (user.role === 'admin') {
    return { allowed: true, userType: 'admin' };
  }

  if (user.is_responder === true) {
    return { allowed: true, userType: user.user_type };
  }

  return { allowed: false, reason: 'Responder access required' };
};

/**
 * Express guard around [resolveResponderAccess]. Attaches req.user.user_type.
 */
const requireResponder = async (req, res, next) => {
  if (!req.user || !req.user.id) {
    return unauthorized(res, 'Access token is required');
  }

  try {
    const access = await resolveResponderAccess(req.user.id);
    if (!access.allowed) {
      return forbidden(res, access.reason);
    }
    req.user.user_type = access.userType;
    return next();
  } catch (err) {
    console.error('Responder check error:', err);
    // Fail closed. An unavailable database must not open the emergency feed.
    return error(res, 'Failed to verify responder access', 500);
  }
};

module.exports = {
  authenticate,
  requireAdmin,
  requireResponder,
  resolveResponderAccess,
};
