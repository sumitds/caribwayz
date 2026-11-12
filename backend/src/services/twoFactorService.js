const crypto = require('crypto');
const { generateCode: generateSixDigitCode, digestMatches, sha256Hex } = require('../utils/oneTimeCode');

/**
 * Two-step sign-in by a six-digit code sent to the account's email
 * (migration 022). Built the way the password reset code is (migration 019):
 * only a hash of the code is stored, it expires, each code allows a few
 * guesses, and per-account limits on codes sent and wrong guesses survive a
 * new code being issued.
 *
 * Two purposes share the columns, one code at a time per account:
 *   'sign_in'  sent after a correct password when two-step sign-in is on.
 *              The person also holds a random challenge, returned with the
 *              password check and stored only as a hash, so the code works
 *              only for the sign-in whose password was checked.
 *   'enable'   sent when a signed-in person asks to turn two-step sign-in on,
 *              to prove the address receives mail before anything depends
 *              on it.
 *
 * The code and the challenge are never logged.
 */

const PURPOSES = ['sign_in', 'enable'];

const TWO_FACTOR_CODE_TTL_MINUTES = 10;
const TWO_FACTOR_MAX_ATTEMPTS = 5;
const TWO_FACTOR_CODES_PER_WINDOW = 5;
const TWO_FACTOR_CODE_WINDOW_MS = 60 * 60 * 1000;
const TWO_FACTOR_GUESSES_PER_WINDOW = 10;
const TWO_FACTOR_GUESS_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 32 random bytes, base64url without padding: always 43 characters. */
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const isChallenge = (value) => typeof value === 'string' && CHALLENGE_PATTERN.test(value);

/**
 * The stored form of a code. Salted with the user id, and namespaced so it
 * never equals the hash of the same digits as a password reset code.
 */
const hashTwoFactorCode = (userId, code) => sha256Hex(`two-factor:${userId}:${code}`);

const hashChallenge = (challenge) => sha256Hex(`two-factor-challenge:${challenge}`);

const generateChallenge = () => crypto.randomBytes(32).toString('base64url');

/**
 * @param {object} deps
 * @param {(text: string, params?: any[]) => Promise<{rows: any[], rowCount: number}>} deps.query
 * @param {() => boolean} deps.isEmailConfigured
 * @param {(args: {toEmail: string, code: string, expiresInMinutes: number, purpose: string}) => Promise<void>} deps.sendCode
 * @param {() => string} [deps.generateCode]
 * @param {() => string} [deps.newChallenge]
 * @param {() => Date} [deps.now]
 */
const buildTwoFactorService = ({
  query,
  isEmailConfigured,
  sendCode,
  generateCode = generateSixDigitCode,
  newChallenge = generateChallenge,
  now = () => new Date(),
}) => {
  /**
   * Issues and emails a code for [user] ({id, email}).
   *
   * Resolves to one of:
   *   { status: 'sent', challenge, expiresInMinutes }  challenge is null for 'enable'
   *   { status: 'unavailable' }  outgoing mail is not configured
   *   { status: 'limited' }      too many codes sent this hour
   *   { status: 'locked' }       too many wrong guesses today
   *   { status: 'send_failed' }  the email could not be sent; the code is void
   * Throws only when the database cannot be reached.
   */
  const issueCode = async ({ user, purpose }) => {
    if (!PURPOSES.includes(purpose)) throw new Error(`issueCode: unknown purpose ${purpose}`);
    if (!isEmailConfigured()) return { status: 'unavailable' };

    const code = generateCode();
    const codeHash = hashTwoFactorCode(user.id, code);
    const challenge = purpose === 'sign_in' ? newChallenge() : null;
    const challengeHash = challenge ? hashChallenge(challenge) : null;
    const at = now();
    const expiresAt = new Date(at.getTime() + TWO_FACTOR_CODE_TTL_MINUTES * 60 * 1000);
    const codeWindowStart = new Date(at.getTime() - TWO_FACTOR_CODE_WINDOW_MS);
    const guessWindowStart = new Date(at.getTime() - TWO_FACTOR_GUESS_WINDOW_MS);

    // Checked and counted in one statement, so parallel requests cannot all
    // slip in under the limit. SET expressions read the row as it was.
    const issued = await query(
      `UPDATE users
          SET two_factor_code_hash = $1, two_factor_challenge_hash = $2, two_factor_purpose = $3,
              two_factor_expires_at = $4, two_factor_attempts = 0,
              two_factor_window_started_at = CASE
                WHEN two_factor_window_started_at IS NULL OR two_factor_window_started_at <= $7 THEN $6
                ELSE two_factor_window_started_at END,
              two_factor_codes_issued = CASE
                WHEN two_factor_window_started_at IS NULL OR two_factor_window_started_at <= $7 THEN 1
                ELSE two_factor_codes_issued + 1 END
        WHERE id = $5
          AND (two_factor_window_started_at IS NULL OR two_factor_window_started_at <= $7
               OR two_factor_codes_issued < $8)
          AND (two_factor_guesses_started_at IS NULL OR two_factor_guesses_started_at <= $9
               OR two_factor_guesses < $10)
        RETURNING id`,
      [codeHash, challengeHash, purpose, expiresAt, user.id, at, codeWindowStart,
        TWO_FACTOR_CODES_PER_WINDOW, guessWindowStart, TWO_FACTOR_GUESSES_PER_WINDOW]
    );

    if (issued.rowCount === 0) {
      const state = await query(
        `SELECT two_factor_guesses_started_at > $2 AND two_factor_guesses >= $3 AS locked
           FROM users WHERE id = $1`,
        [user.id, guessWindowStart, TWO_FACTOR_GUESSES_PER_WINDOW]
      );
      const locked = state.rows.length > 0 && state.rows[0].locked === true;
      console.warn(`Two-step code refused: ${locked ? 'too many wrong codes' : 'too many codes sent'} (user ${user.id})`);
      return { status: locked ? 'locked' : 'limited' };
    }

    try {
      await sendCode({ toEmail: user.email, code, expiresInMinutes: TWO_FACTOR_CODE_TTL_MINUTES, purpose });
    } catch (err) {
      console.error(`Two-step code email failed (user ${user.id}):`, err.message);
      try {
        await query(
          `UPDATE users SET two_factor_code_hash = NULL, two_factor_challenge_hash = NULL,
                  two_factor_purpose = NULL, two_factor_expires_at = NULL, two_factor_attempts = 0
            WHERE id = $1 AND two_factor_code_hash = $2`,
          [user.id, codeHash]
        );
      } catch (voidErr) {
        console.error(`Voiding an undelivered two-step code failed (user ${user.id}):`, voidErr.message);
      }
      return { status: 'send_failed' };
    }

    return { status: 'sent', challenge, expiresInMinutes: TWO_FACTOR_CODE_TTL_MINUTES };
  };

  /**
   * Checks [code] for a pending sign-in (by [challenge]) or a pending
   * switch-on (by [userId]). A correct code is used up, and for 'enable'
   * turns two-step sign-in on in the same statement.
   *
   * Resolves to one of:
   *   { status: 'ok', userId }
   *   { status: 'invalid' }    no live code here (wrong challenge, expired, used, void)
   *   { status: 'wrong', attemptsLeft }
   *   { status: 'exhausted' }  that was the last guess for this code; it is void
   *   { status: 'locked' }     too many wrong guesses today; the code is void
   * Throws only when the database cannot be reached.
   */
  const verifyCode = async ({ purpose, challenge, userId, code }) => {
    if (!PURPOSES.includes(purpose)) throw new Error(`verifyCode: unknown purpose ${purpose}`);
    if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) return { status: 'invalid' };

    let target;
    let targetParam;
    if (purpose === 'sign_in') {
      if (!isChallenge(challenge)) return { status: 'invalid' };
      target = 'two_factor_challenge_hash = $1 AND two_factor_enabled = TRUE';
      targetParam = hashChallenge(challenge);
    } else {
      if (typeof userId !== 'string' || userId === '') return { status: 'invalid' };
      target = 'id = $1';
      targetParam = userId;
    }

    // Spends one attempt on this code and one of the account's daily guesses
    // before comparing, atomically, so parallel guesses cannot all slip in
    // under either limit.
    const at = now();
    const guessWindowStart = new Date(at.getTime() - TWO_FACTOR_GUESS_WINDOW_MS);
    const claimed = await query(
      `UPDATE users SET two_factor_attempts = two_factor_attempts + 1,
              two_factor_guesses_started_at = CASE
                WHEN two_factor_guesses_started_at IS NULL OR two_factor_guesses_started_at <= $5 THEN $3
                ELSE two_factor_guesses_started_at END,
              two_factor_guesses = CASE
                WHEN two_factor_guesses_started_at IS NULL OR two_factor_guesses_started_at <= $5 THEN 1
                ELSE two_factor_guesses + 1 END
        WHERE ${target}
          AND two_factor_purpose = $2
          AND auth_provider = 'email' AND status = 'active'
          AND two_factor_code_hash IS NOT NULL
          AND two_factor_expires_at > $3
          AND two_factor_attempts < $4
          AND (two_factor_guesses_started_at IS NULL OR two_factor_guesses_started_at <= $5
               OR two_factor_guesses < $6)
        RETURNING id, two_factor_code_hash, two_factor_attempts, two_factor_guesses`,
      [targetParam, purpose, at, TWO_FACTOR_MAX_ATTEMPTS, guessWindowStart, TWO_FACTOR_GUESSES_PER_WINDOW]
    );
    if (claimed.rows.length === 0) return { status: 'invalid' };

    const row = claimed.rows[0];
    if (!digestMatches(hashTwoFactorCode(row.id, code), row.two_factor_code_hash)) {
      const lockedOut = row.two_factor_guesses >= TWO_FACTOR_GUESSES_PER_WINDOW;
      if (lockedOut || row.two_factor_attempts >= TWO_FACTOR_MAX_ATTEMPTS) {
        await query(
          `UPDATE users SET two_factor_code_hash = NULL, two_factor_challenge_hash = NULL,
                  two_factor_purpose = NULL, two_factor_expires_at = NULL
            WHERE id = $1 AND two_factor_code_hash = $2`,
          [row.id, row.two_factor_code_hash]
        );
        console.warn(`Two-step code voided after wrong guesses (user ${row.id})`);
        return { status: lockedOut ? 'locked' : 'exhausted' };
      }
      return { status: 'wrong', attemptsLeft: TWO_FACTOR_MAX_ATTEMPTS - row.two_factor_attempts };
    }

    // Uses the code up. Conditional on it still being the same code, so two
    // correct submissions at once succeed only once, and a code replaced by a
    // newer one in the meantime no longer works. Either purpose's code was
    // emailed to the account's address, so a correct one proves the person
    // reads that inbox (users.email_verified, migration 031).
    const enables = purpose === 'enable' ? ', two_factor_enabled = TRUE' : '';
    const consumed = await query(
      `UPDATE users
          SET two_factor_code_hash = NULL, two_factor_challenge_hash = NULL, two_factor_purpose = NULL,
              two_factor_expires_at = NULL, two_factor_attempts = 0,
              two_factor_guesses = 0, two_factor_guesses_started_at = NULL,
              email_verified = TRUE${enables}
        WHERE id = $1 AND two_factor_code_hash = $2`,
      [row.id, row.two_factor_code_hash]
    );
    if (consumed.rowCount === 0) return { status: 'invalid' };
    return { status: 'ok', userId: row.id };
  };

  /**
   * Turns two-step sign-in off and voids any outstanding code. The daily
   * guess count is kept, so switching off and on cannot reset the lockout.
   */
  const disable = async (userId) => {
    await query(
      `UPDATE users
          SET two_factor_enabled = FALSE, two_factor_code_hash = NULL, two_factor_challenge_hash = NULL,
              two_factor_purpose = NULL, two_factor_expires_at = NULL, two_factor_attempts = 0
        WHERE id = $1`,
      [userId]
    );
  };

  return { issueCode, verifyCode, disable };
};

module.exports = {
  buildTwoFactorService,
  hashTwoFactorCode,
  hashChallenge,
  isChallenge,
  generateChallenge,
  PURPOSES,
  TWO_FACTOR_CODE_TTL_MINUTES,
  TWO_FACTOR_MAX_ATTEMPTS,
  TWO_FACTOR_CODES_PER_WINDOW,
  TWO_FACTOR_GUESSES_PER_WINDOW,
};
