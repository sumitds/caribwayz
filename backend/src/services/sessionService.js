const jwt = require('jsonwebtoken');
const crypto = require('crypto');

/**
 * Sign-in sessions (migration 022).
 *
 * Every successful sign-in writes one user_sessions row and puts its id in
 * the token as the claim "sid". The row is the sign-in history the app shows,
 * and the switch that turns the token off: middleware/auth.js accepts a token
 * only while its row is there and not revoked. There is no refresh token in
 * this API, so nothing else creates a session.
 *
 * A token without a sid (issued before migration 022) could never be signed
 * out, so middleware/auth.js and the group sockets refuse it as signed out.
 */

const METHODS = ['email', 'google', 'facebook', 'phone'];
const PLATFORMS = ['android', 'ios', 'web'];

/** How many sign-ins the history returns. */
const HISTORY_LIMIT = 20;

/**
 * Rows older than this are deleted when the same account signs in again,
 * once they no longer hold a usable session.
 */
const HISTORY_RETENTION_DAYS = 90;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isSessionId = (value) => typeof value === 'string' && UUID_PATTERN.test(value);

/**
 * Who hears that sessions were signed out, so that something holding an open
 * connection for one (wsService's group sockets) can close it. Per process,
 * as the sockets are.
 */
const revocationListeners = new Set();

/** Calls [listener] with the ids of every batch of sessions signed out. Returns an unsubscribe. */
const onSessionsRevoked = (listener) => {
  revocationListeners.add(listener);
  return () => revocationListeners.delete(listener);
};

/** Tells every listener these sessions were signed out. A listener that throws is logged and skipped. */
const notifySessionsRevoked = (sessionIds) => {
  const ids = (sessionIds || []).filter(isSessionId);
  if (ids.length === 0) return;
  for (const listener of revocationListeners) {
    try {
      listener(ids);
    } catch (err) {
      console.error('A session sign-out listener failed:', err.message);
    }
  }
};

/**
 * Which kind of device the request came from: the platform the app names in
 * X-Client-Platform, or a coarse guess from the User-Agent. Never anything
 * finer than android / ios / web / unknown, and nothing from the IP.
 */
const clientPlatform = (req) => {
  const headers = (req && req.headers) || {};
  const named = typeof headers['x-client-platform'] === 'string'
    ? headers['x-client-platform'].trim().toLowerCase()
    : '';
  if (PLATFORMS.includes(named)) return named;

  const agent = typeof headers['user-agent'] === 'string' ? headers['user-agent'] : '';
  if (/android/i.test(agent)) return 'android';
  if (/iphone|ipad|ipod|\bios\b|darwin/i.test(agent)) return 'ios';
  if (/mozilla\//i.test(agent)) return 'web';
  return 'unknown';
};

/**
 * @param {object} deps
 * @param {(text: string, params?: any[]) => Promise<{rows: any[], rowCount: number}>} deps.query
 * @param {(payload: object) => string} deps.generateToken signs a token; must set exp
 * @param {(token: string) => object|null} [deps.decodeToken] reads a token's claims without verifying
 * @param {() => string} [deps.newId]
 * @param {() => Date} [deps.now]
 */
const buildSessionService = ({
  query,
  generateToken,
  decodeToken = (token) => jwt.decode(token),
  newId = () => crypto.randomUUID(),
  now = () => new Date(),
}) => {
  /**
   * Records a sign-in and returns the token for it. Throws when the row
   * cannot be written: a token whose session does not exist would be refused
   * on its first use, so the sign-in fails instead.
   */
  const startSession = async ({ user, method, platform }) => {
    if (!METHODS.includes(method)) throw new Error(`startSession: unknown sign-in method ${method}`);
    const safePlatform = PLATFORMS.includes(platform) ? platform : 'unknown';
    const sid = newId();
    const token = generateToken({ id: user.id, email: user.email, role: user.role, sid });

    const claims = decodeToken(token);
    if (!claims || !Number.isFinite(claims.exp)) {
      throw new Error('startSession: the signed token has no expiry');
    }
    const expiresAt = new Date(claims.exp * 1000);
    const at = now();

    await query(
      `INSERT INTO user_sessions (id, user_id, method, platform, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sid, user.id, method, safePlatform, at, expiresAt]
    );

    // Housekeeping. The sign-in has already succeeded, so a failure here is
    // logged and left for the next one.
    try {
      await query(
        `DELETE FROM user_sessions
          WHERE user_id = $1 AND created_at < $2 AND (revoked_at IS NOT NULL OR expires_at <= $3)`,
        [user.id, new Date(at.getTime() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000), at]
      );
    } catch (err) {
      console.error(`Pruning old sign-ins failed (user ${user.id}):`, err.message);
    }

    return token;
  };

  /** Whether the session behind a token with a sid may still be used. */
  const isSessionActive = async ({ sessionId, userId }) => {
    if (!isSessionId(sessionId)) return false;
    const result = await query(
      `SELECT 1 FROM user_sessions
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > $3`,
      [sessionId, userId, now()]
    );
    return result.rows.length > 0;
  };

  /** The most recent sign-ins, newest first, each marked active or not. */
  const listSessions = async ({ userId, currentSessionId }) => {
    const at = now();
    const result = await query(
      `SELECT id, method, platform, created_at, expires_at, revoked_at
         FROM user_sessions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [userId, HISTORY_LIMIT]
    );
    return result.rows.map((row) => ({
      id: row.id,
      method: row.method,
      platform: row.platform,
      signed_in_at: row.created_at,
      expires_at: row.expires_at,
      signed_out_at: row.revoked_at,
      active: row.revoked_at === null && new Date(row.expires_at) > at,
      current: isSessionId(currentSessionId) && row.id === currentSessionId,
    }));
  };

  /** Ends one session of this user. Returns whether one was ended. */
  const revokeSession = async ({ sessionId, userId }) => {
    if (!isSessionId(sessionId)) return false;
    const result = await query(
      `UPDATE user_sessions SET revoked_at = $3
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
        RETURNING id`,
      [sessionId, userId, now()]
    );
    notifySessionsRevoked(result.rows.map((r) => r.id));
    return result.rows.length > 0;
  };

  /**
   * Ends every session of this user except [keepSessionId]. A caller whose
   * token has no sid keeps nothing, which is every recorded session. Returns
   * how many were ended.
   */
  const revokeOtherSessions = async ({ userId, keepSessionId }) => {
    const keep = isSessionId(keepSessionId) ? keepSessionId : null;
    const at = now();
    const result = await query(
      `UPDATE user_sessions SET revoked_at = $2
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2
          AND ($3::uuid IS NULL OR id <> $3::uuid)
        RETURNING id`,
      [userId, at, keep]
    );
    notifySessionsRevoked(result.rows.map((r) => r.id));
    return result.rows.length;
  };

  /** Ends every session of this user, as after a password reset. Returns how many. */
  const revokeAllSessions = ({ userId }) => revokeOtherSessions({ userId, keepSessionId: null });

  return { startSession, isSessionActive, listSessions, revokeSession, revokeOtherSessions, revokeAllSessions };
};

let defaultService = null;

/**
 * The service on the shared pool and the real signing key. Built on first use
 * so that requiring this file loads neither.
 */
const sessionService = () => {
  if (!defaultService) {
    const { query } = require('../config/db');
    const { generateToken } = require('../utils/jwt');
    defaultService = buildSessionService({ query, generateToken });
  }
  return defaultService;
};

module.exports = {
  buildSessionService,
  sessionService,
  clientPlatform,
  isSessionId,
  onSessionsRevoked,
  notifySessionsRevoked,
  METHODS,
  PLATFORMS,
  HISTORY_LIMIT,
  HISTORY_RETENTION_DAYS,
};
