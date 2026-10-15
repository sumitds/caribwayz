const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const emailService = require('../services/emailService');
const { sessionService, isSessionId } = require('../services/sessionService');
const { buildTwoFactorService } = require('../services/twoFactorService');
const { maskEmail } = require('./authController');
const { success, error, forbidden, notFound } = require('../utils/response');

/**
 * Account security for the signed-in person: their sign-in history, signing
 * out their other devices, and turning two-step sign-in on and off.
 *
 * Two-step sign-in is for email+password accounts only. A Google, Facebook or
 * phone sign-in is already confirmed by that provider (a Google account's own
 * security, or a code texted to the phone), and those accounts have no
 * CaribWayz password to pair a code with.
 */

const MESSAGES = {
  SIGNED_OUT_OTHERS: 'Your other devices have been signed out.',
  NOTHING_TO_SIGN_OUT: 'No other devices were signed in.',
  NOT_AVAILABLE: 'Two-step sign-in is for accounts that sign in with an email and password. '
    + 'Google, Facebook and phone sign-in are already confirmed by Google, Facebook or a text to your phone.',
  ALREADY_ON: 'Two-step sign-in is already on.',
  ALREADY_OFF: 'Two-step sign-in is already off.',
  PASSWORD_REQUIRED: 'Enter your password to continue.',
  PASSWORD_WRONG: 'Password is incorrect',
  CODE_SENT: 'We emailed you a 6-digit code. Enter it to turn on two-step sign-in.',
  UNAVAILABLE: "We can't send codes by email right now. Please try again later.",
  SEND_FAILED: "We couldn't send the code. Please try again in a few minutes.",
  LIMITED: 'Too many codes requested. Please wait an hour and try again.',
  LOCKED: 'Too many incorrect codes. Please try again tomorrow.',
  INVALID: 'This code is invalid or has expired. Please ask for a new one.',
  EXHAUSTED: 'Too many incorrect codes. Please ask for a new one.',
  TURNED_ON: 'Two-step sign-in is on. Next time you sign in with your password, we will email you a code.',
  TURNED_OFF: 'Two-step sign-in is off.',
};

/** A 4xx whose data.code tells the app which recovery to offer. */
const failWithCode = (res, statusCode, message, code, extra = {}) =>
  res.status(statusCode).json({ success: false, message, data: { ...extra, code } });

/**
 * @param {object} deps
 * @param {(text: string, params?: any[]) => Promise<{rows: any[], rowCount: number}>} deps.query
 * @param {() => object} deps.sessions services/sessionService.js
 * @param {{issueCode: Function, verifyCode: Function, disable: Function}} deps.twoFactor
 * @param {(plain: string, hash: string) => Promise<boolean>} [deps.comparePassword]
 */
const buildSecurityHandlers = ({
  query,
  sessions,
  twoFactor,
  comparePassword = (plain, hash) => bcrypt.compare(plain, hash),
}) => {
  const currentSessionId = (req) => (isSessionId(req.user.sid) ? req.user.sid : null);

  const listSessions = async (req, res) => {
    try {
      const currentId = currentSessionId(req);
      const rows = await sessions().listSessions({ userId: req.user.id, currentSessionId: currentId });
      return success(res, { sessions: rows, current_session_recorded: currentId !== null });
    } catch (err) {
      console.error(`List sign-ins error (user ${req.user.id}):`, err);
      return error(res, 'Your sign-in history could not be loaded', 500);
    }
  };

  const signOutOtherSessions = async (req, res) => {
    try {
      const count = await sessions().revokeOtherSessions({
        userId: req.user.id,
        keepSessionId: currentSessionId(req),
      });
      return success(res, { signed_out: count },
        count > 0 ? MESSAGES.SIGNED_OUT_OTHERS : MESSAGES.NOTHING_TO_SIGN_OUT);
    } catch (err) {
      console.error(`Sign out other devices error (user ${req.user.id}):`, err);
      return error(res, 'Your other devices could not be signed out. Please try again.', 500);
    }
  };

  /** The account as two-step sign-in sees it, or null when it is gone. */
  const loadAccount = async (userId) => {
    const result = await query(
      `SELECT id, email, auth_provider, password_hash, two_factor_enabled
         FROM users WHERE id = $1`,
      [userId]
    );
    return result.rows[0] || null;
  };

  const isEligible = (account) =>
    account.auth_provider === 'email' && typeof account.email === 'string' && account.email !== ''
    && typeof account.password_hash === 'string' && account.password_hash !== '';

  /**
   * Checks the password in the body against the account. Answers the request
   * itself and returns false when it does not match. 403, not 401: the
   * session is valid and the app must not sign the person out over a typo.
   */
  const passwordMatches = async (req, res, account) => {
    const { password } = req.body || {};
    if (typeof password !== 'string' || password.length === 0) {
      error(res, MESSAGES.PASSWORD_REQUIRED, 400);
      return false;
    }
    if (!(await comparePassword(password, account.password_hash))) {
      forbidden(res, MESSAGES.PASSWORD_WRONG);
      return false;
    }
    return true;
  };

  const getTwoFactor = async (req, res) => {
    try {
      const account = await loadAccount(req.user.id);
      if (!account) return notFound(res, 'User not found');
      const available = isEligible(account);
      return success(res, {
        available,
        enabled: available && account.two_factor_enabled === true,
        email_hint: available ? maskEmail(account.email) : null,
      });
    } catch (err) {
      console.error(`Two-step status error (user ${req.user.id}):`, err);
      return error(res, 'Your two-step sign-in setting could not be loaded', 500);
    }
  };

  /** Step one of turning it on: the password, then a code to the email. */
  const startTwoFactorSetup = async (req, res) => {
    try {
      const account = await loadAccount(req.user.id);
      if (!account) return notFound(res, 'User not found');
      if (!isEligible(account)) return failWithCode(res, 409, MESSAGES.NOT_AVAILABLE, 'TWO_FACTOR_NOT_AVAILABLE');
      if (account.two_factor_enabled === true) return failWithCode(res, 409, MESSAGES.ALREADY_ON, 'TWO_FACTOR_ALREADY_ON');
      if (!(await passwordMatches(req, res, account))) return undefined;

      const issued = await twoFactor.issueCode({ user: account, purpose: 'enable' });
      switch (issued.status) {
        case 'sent':
          return success(res, {
            email_hint: maskEmail(account.email),
            expires_in_minutes: issued.expiresInMinutes,
          }, MESSAGES.CODE_SENT);
        case 'unavailable':
          return failWithCode(res, 503, MESSAGES.UNAVAILABLE, 'TWO_FACTOR_UNAVAILABLE');
        case 'send_failed':
          return failWithCode(res, 503, MESSAGES.SEND_FAILED, 'TWO_FACTOR_SEND_FAILED');
        case 'limited':
          return failWithCode(res, 429, MESSAGES.LIMITED, 'TWO_FACTOR_LIMITED');
        case 'locked':
          return failWithCode(res, 429, MESSAGES.LOCKED, 'TWO_FACTOR_LOCKED');
        default:
          throw new Error(`unexpected two-step issue status ${issued.status}`);
      }
    } catch (err) {
      console.error(`Two-step setup error (user ${req.user.id}):`, err);
      return error(res, 'Two-step sign-in could not be set up. Please try again.', 500);
    }
  };

  /** Step two of turning it on: the emailed code. */
  const confirmTwoFactorSetup = async (req, res) => {
    try {
      const checked = await twoFactor.verifyCode({ purpose: 'enable', userId: req.user.id, code: req.body.code });
      switch (checked.status) {
        case 'ok':
          return success(res, { enabled: true }, MESSAGES.TURNED_ON);
        case 'wrong': {
          const left = checked.attemptsLeft;
          return failWithCode(res, 400, `Incorrect code. ${left} ${left === 1 ? 'attempt' : 'attempts'} left.`,
            'TWO_FACTOR_WRONG', { attempts_left: left });
        }
        case 'exhausted':
          return failWithCode(res, 400, MESSAGES.EXHAUSTED, 'TWO_FACTOR_EXHAUSTED');
        case 'locked':
          return failWithCode(res, 429, MESSAGES.LOCKED, 'TWO_FACTOR_LOCKED');
        case 'invalid':
          return failWithCode(res, 400, MESSAGES.INVALID, 'TWO_FACTOR_INVALID');
        default:
          throw new Error(`unexpected two-step verify status ${checked.status}`);
      }
    } catch (err) {
      console.error(`Two-step confirm error (user ${req.user.id}):`, err);
      return error(res, 'Two-step sign-in could not be turned on. Please try again.', 500);
    }
  };

  const disableTwoFactor = async (req, res) => {
    try {
      const account = await loadAccount(req.user.id);
      if (!account) return notFound(res, 'User not found');
      if (!isEligible(account)) return failWithCode(res, 409, MESSAGES.NOT_AVAILABLE, 'TWO_FACTOR_NOT_AVAILABLE');
      if (account.two_factor_enabled !== true) return failWithCode(res, 409, MESSAGES.ALREADY_OFF, 'TWO_FACTOR_ALREADY_OFF');
      if (!(await passwordMatches(req, res, account))) return undefined;

      await twoFactor.disable(account.id);
      return success(res, { enabled: false }, MESSAGES.TURNED_OFF);
    } catch (err) {
      console.error(`Two-step disable error (user ${req.user.id}):`, err);
      return error(res, 'Two-step sign-in could not be turned off. Please try again.', 500);
    }
  };

  return {
    listSessions,
    signOutOtherSessions,
    getTwoFactor,
    startTwoFactorSetup,
    confirmTwoFactorSetup,
    disableTwoFactor,
  };
};

const handlers = buildSecurityHandlers({
  query,
  sessions: sessionService,
  twoFactor: buildTwoFactorService({
    query,
    isEmailConfigured: emailService.isEmailConfigured,
    sendCode: emailService.sendTwoFactorCode,
  }),
});

module.exports = { ...handlers, buildSecurityHandlers, MESSAGES };
