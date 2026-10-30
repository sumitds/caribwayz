const net = require('net');
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

/**
 * The eight 16-bit groups of an IPv6 address, or null when [ip] is not one.
 * A zone ("%eth0") is dropped and an embedded IPv4 tail becomes two groups.
 */
const ipv6Groups = (ip) => {
  const address = String(ip).split('%')[0];
  if (!net.isIPv6(address)) return null;
  const toGroups = (part) => {
    if (part === '') return [];
    return part.split(':').flatMap((g) => {
      if (!g.includes('.')) return [parseInt(g, 16)];
      const [a, b, c, d] = g.split('.').map(Number);
      return [(a << 8) | b, (c << 8) | d];
    });
  };
  const [head, tail] = address.includes('::') ? address.split('::') : [address, null];
  const front = toGroups(head);
  const back = tail === null ? [] : toGroups(tail);
  const zeros = new Array(8 - front.length - back.length).fill(0);
  return [...front, ...zeros, ...back];
};

/**
 * The client's network for a per-IP limit. An IPv4 address is itself. An
 * IPv6 address counts by its /64: one home or phone is normally given a whole
 * /64, so counting single addresses would let one sender take a new address
 * for every request. An IPv4 address written as IPv6 (::ffff:1.2.3.4) counts
 * as the IPv4 address.
 */
const clientNetworkKey = (req) => {
  const ip = req.ip || '';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  const groups = ipv6Groups(ip);
  if (!groups) return ip;
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
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
  // The public /membership form. Each call stores a row and emails the team.
  membershipApply: {
    max: 5,
    windowMs: 60 * 60 * 1000,
    message: 'Too many applications from this connection. Please wait an hour and try again, or email us.',
  },
};

const firebaseSignInLimiter = buildLimiter(LIMITS.firebaseSignIn);
const loginLimiter = buildLimiter({ ...LIMITS.login, keyGenerator: ipAndEmailKey });
const forgotPasswordLimiter = buildLimiter(LIMITS.forgotPassword);
const resetVerifyLimiter = buildLimiter(LIMITS.resetVerify);
const twoFactorVerifyLimiter = buildLimiter(LIMITS.twoFactorVerify);
const membershipApplyLimiter = buildLimiter({ ...LIMITS.membershipApply, keyGenerator: clientNetworkKey });

module.exports = {
  LIMITS,
  buildLimiter,
  firebaseSignInLimiter,
  loginLimiter,
  ipAndEmailKey,
  clientNetworkKey,
  forgotPasswordLimiter,
  resetVerifyLimiter,
  twoFactorVerifyLimiter,
  membershipApplyLimiter,
};
