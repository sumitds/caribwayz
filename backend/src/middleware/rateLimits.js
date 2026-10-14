const rateLimit = require('express-rate-limit');

/**
 * Per-IP limits for the unauthenticated auth endpoints that are worth abusing.
 *
 * The global limiter in server.js (100 requests per 15 minutes) is shared by
 * every route, so on its own it would allow a hundred password reset guesses or
 * reset emails per address per window. These sit in front of the specific
 * routes and are much tighter. The per-account cap on wrong reset codes lives
 * in the controller; this only slows down one address hammering many accounts.
 *
 * Counts are per process (the default memory store), which is what the global
 * limiter already does.
 */

const WINDOW_MS = 15 * 60 * 1000;

const tooMany = (message) => ({ success: false, message });

/** Builds a limiter. A factory so tests get a fresh, independent counter. */
const buildLimiter = ({ max, message, windowMs = WINDOW_MS }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: tooMany(message),
  });

const LIMITS = {
  // Google, Facebook and phone sign-in. Each call verifies a Firebase token,
  // so this is mostly about not being a free token-checking oracle.
  firebaseSignIn: { max: 30, message: 'Too many sign-in attempts. Please wait a few minutes and try again.' },
  // Each call can send an email to someone else's inbox.
  forgotPassword: { max: 5, message: 'Too many password reset requests. Please wait 15 minutes and try again.' },
  // Each call is a guess at a six-digit code.
  resetVerify: { max: 10, message: 'Too many attempts. Please wait 15 minutes and try again.' },
};

const firebaseSignInLimiter = buildLimiter(LIMITS.firebaseSignIn);
const forgotPasswordLimiter = buildLimiter(LIMITS.forgotPassword);
const resetVerifyLimiter = buildLimiter(LIMITS.resetVerify);

module.exports = {
  LIMITS,
  buildLimiter,
  firebaseSignInLimiter,
  forgotPasswordLimiter,
  resetVerifyLimiter,
};
