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

/**
 * Builds a limiter. A factory so tests get a fresh, independent counter.
 * [keyGenerator] narrows the count; the default is the client IP.
 */
const buildLimiter = ({ max, message, windowMs = WINDOW_MS, keyGenerator }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: tooMany(message),
    ...(keyGenerator ? { keyGenerator } : {}),
  });

/**
 * The client IP and the email being signed in to, so one address guessing
 * passwords for one account is stopped without locking out everyone behind
 * the same address (a hotel, a carrier NAT). The email is compared as typed
 * apart from case and surrounding spaces.
 */
const ipAndEmailKey = (req) => {
  const email = req.body && typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  return `${req.ip}|${email}`;
};

const LIMITS = {
  // Google, Facebook and phone sign-in. Each call verifies a Firebase token,
  // so this is mostly about not being a free token-checking oracle.
  firebaseSignIn: { max: 30, message: 'Too many sign-in attempts. Please wait a few minutes and try again.' },
  // Each call is a password guess. Counted per address and email (ipAndEmailKey).
  login: { max: 10, message: 'Too many sign-in attempts. Please wait 15 minutes and try again.' },
  // Each call can send an email to someone else's inbox.
  forgotPassword: { max: 5, message: 'Too many password reset requests. Please wait 15 minutes and try again.' },
  // Each call is a guess at a six-digit code.
  resetVerify: { max: 10, message: 'Too many attempts. Please wait 15 minutes and try again.' },
  // Each call is a guess at a two-step sign-in code.
  twoFactorVerify: { max: 10, message: 'Too many attempts. Please wait 15 minutes and try again.' },
};

const firebaseSignInLimiter = buildLimiter(LIMITS.firebaseSignIn);
const loginLimiter = buildLimiter({ ...LIMITS.login, keyGenerator: ipAndEmailKey });
const forgotPasswordLimiter = buildLimiter(LIMITS.forgotPassword);
const resetVerifyLimiter = buildLimiter(LIMITS.resetVerify);
const twoFactorVerifyLimiter = buildLimiter(LIMITS.twoFactorVerify);

module.exports = {
  LIMITS,
  buildLimiter,
  firebaseSignInLimiter,
  loginLimiter,
  ipAndEmailKey,
  forgotPasswordLimiter,
  resetVerifyLimiter,
  twoFactorVerifyLimiter,
};
