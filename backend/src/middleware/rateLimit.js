const rateLimit = require('express-rate-limit');

/**
 * A rate limit per signed-in account, not per IP. Mount it after `authenticate`:
 * the key is the caller's user id. [scope] narrows the key further, for a limit
 * that applies per account and per something else (a group, say).
 */
const perUser = (max, windowMs, message, scope) => rateLimit({
  windowMs,
  max,
  keyGenerator: (req) => (scope ? `user:${req.user.id}:${scope(req)}` : `user:${req.user.id}`),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message },
});

module.exports = { perUser };
