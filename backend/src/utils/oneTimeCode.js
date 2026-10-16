const crypto = require('crypto');

/**
 * Six-digit codes sent by email: the password reset code (migration 019) and
 * the two-step sign-in code (migration 022). Only a SHA-256 hex digest of a
 * code is ever stored.
 */

/** A uniformly random six-digit code, leading zeros kept. */
const generateCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

/** Constant-time comparison of two hex digests. False for anything malformed. */
const digestMatches = (candidateHex, storedHex) => {
  if (typeof candidateHex !== 'string' || typeof storedHex !== 'string') return false;
  const a = Buffer.from(candidateHex, 'hex');
  const b = Buffer.from(storedHex, 'hex');
  return a.length === 32 && a.length === b.length && crypto.timingSafeEqual(a, b);
};

const sha256Hex = (text) => crypto.createHash('sha256').update(text).digest('hex');

module.exports = { generateCode, digestMatches, sha256Hex };
