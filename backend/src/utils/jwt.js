const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

/**
 * Resolves the signing secret, refusing to run on a published fallback.
 *
 * The previous default was a literal in this file. Anyone holding the
 * repository could mint a token for any user id with role 'admin', which now
 * also carries emergency-responder access to the live location of every person
 * currently in an emergency. In production the process stops rather than
 * accepting that; elsewhere it falls back to a per-process random key, so
 * tokens simply do not survive a restart and nothing is forgeable from a value
 * published in the repo.
 */
/** The value this file used to fall back to. Published in the repository. */
const PUBLISHED_DEFAULT = 'caribwayz_secret_change_in_production';

const RECOMMENDED_LENGTH = 32;

const resolveSecret = () => {
  const configured = process.env.JWT_SECRET;
  const inProduction = process.env.NODE_ENV === 'production';

  // The one condition that must stop the process: a signing key anybody
  // holding this repository already knows. Every token is forgeable against
  // it, including one claiming role 'admin'.
  if (configured === PUBLISHED_DEFAULT) {
    throw new Error(
      'JWT_SECRET is set to the value that used to be hardcoded in this file. ' +
      'It is public, every token signed with it is forgeable, and it must be ' +
      'rotated before the service starts.'
    );
  }

  if (configured) {
    // Deliberately a warning rather than a throw. This module is required at
    // startup, so throwing here crash-loops the service and takes the whole
    // API down. A short-but-private key is weaker than it should be; an
    // outage is certain. The warning is loud and the fix is one env var.
    if (configured.length < RECOMMENDED_LENGTH) {
      console.warn(
        `[JWT] JWT_SECRET is ${configured.length} characters. At least ` +
        `${RECOMMENDED_LENGTH} is recommended. Rotate it to a longer random value.`
      );
    }
    return configured;
  }

  if (inProduction) {
    // No key at all in production. A per-process random value keeps the
    // service up and simply invalidates sessions on restart, which is
    // recoverable; starting on a known key is not.
    console.error(
      '[JWT] JWT_SECRET is NOT SET in production. Falling back to a random ' +
      'per-process key: every restart will sign users out. Set JWT_SECRET now.'
    );
  } else {
    console.warn(
      '[JWT] JWT_SECRET is not set. Using a per-process random secret; every ' +
      'restart invalidates existing tokens. Set JWT_SECRET for a stable key.'
    );
  }

  return crypto.randomBytes(48).toString('hex');
};

const SECRET = resolveSecret();

const generateToken = (payload) => {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN });
};

const verifyToken = (token) => {
  return jwt.verify(token, SECRET);
};

module.exports = { generateToken, verifyToken };
