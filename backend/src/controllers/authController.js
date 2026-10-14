const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { query, getClient } = require('../config/db');
const firebase = require('../config/firebase');
const emailService = require('../services/emailService');
const { generateToken } = require('../utils/jwt');
const { success, created, error, unauthorized } = require('../utils/response');
const { isPlaceholderName, normalizeName } = require('../utils/displayName');

const register = async (req, res) => {
  try {
    // user_type is self-declared and grants no access. Emergency-responder
    // authorization is users.is_responder, which only an admin can set through
    // PATCH /api/v1/admin/users/:id/responder. See middleware/auth.js.
    const { name, email, phone, emergency_contact, user_type, password } = req.body;

    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return error(res, 'Email already registered', 409);
    }

    const password_hash = await bcrypt.hash(password, 12);

    const result = await query(
      `INSERT INTO users (name, email, phone, emergency_contact, user_type, password_hash, auth_provider, role)
       VALUES ($1, $2, $3, $4, $5, $6, 'email', 'user')
       RETURNING id, name, email, phone, emergency_contact, user_type, role, status, is_responder, created_at`,
      [name, email, phone, emergency_contact, user_type || 'CaribDrivers', password_hash]
    );

    await query(
      `INSERT INTO user_preferences (user_id) VALUES ($1)`,
      [result.rows[0].id]
    );

    const user = result.rows[0];
    const token = generateToken({ id: user.id, email: user.email, role: user.role });

    return created(res, { user, token }, 'Registration successful');
  } catch (err) {
    console.error('Register error:', err);
    return error(res, 'Registration failed', 500);
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await query(
      `SELECT id, name, email, phone, emergency_contact, user_type, password_hash, role, status, is_responder, profile_image, created_at
       FROM users WHERE email = $1 AND auth_provider = 'email'`,
      [email]
    );

    if (result.rows.length === 0) {
      return unauthorized(res, 'Invalid email or password');
    }

    const user = result.rows[0];

    if (user.status === 'suspended') {
      return error(res, 'Your account has been suspended', 403);
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return unauthorized(res, 'Invalid email or password');
    }

    const { password_hash, ...safeUser } = user;
    const token = generateToken({ id: user.id, email: user.email, role: user.role });

    return success(res, { user: safeUser, token }, 'Login successful');
  } catch (err) {
    console.error('Login error:', err);
    return error(res, 'Login failed', 500);
  }
};

// ── Sign-in with Firebase and password reset ───────────────────────────────

/** Columns returned for a signed-in user: the same shape /login returns. */
const SAFE_USER_COLUMNS = ['id', 'name', 'email', 'phone', 'emergency_contact', 'user_type',
  'role', 'status', 'is_responder', 'profile_image', 'created_at'];
const userColumns = (alias) => SAFE_USER_COLUMNS.map((c) => (alias ? `${alias}.${c}` : c)).join(', ');

/**
 * The three Firebase sign-in routes. [signInProvider] is the value Firebase
 * writes into decoded.firebase.sign_in_provider; a token minted by any other
 * provider is refused, so a phone token cannot be replayed at /google-login.
 *
 * No provider links to an existing account by email: an address already in
 * use answers 409 EMAIL_IN_USE and the person signs in the way they signed up.
 */
const FIREBASE_PROVIDERS = {
  google: { signInProvider: 'google.com' },
  facebook: { signInProvider: 'facebook.com' },
  phone: { signInProvider: 'phone' },
};

const MESSAGES = {
  SIGN_IN_UNAVAILABLE: "This sign-in method isn't available right now",
  SIGN_IN_UNVERIFIED: 'Sign-in could not be verified',
  EMAIL_IN_USE: 'This email is already registered. Sign in the way you first signed up.',
  NAME_REQUIRED: 'Please enter your name to finish signing up',
  SUSPENDED: 'Your account has been suspended',
  RESET_UNAVAILABLE: "Password reset by email isn't available right now. Please contact support.",
  RESET_SENT: 'If this email is registered, a reset code has been sent to it. It expires in 15 minutes.',
  RESET_INVALID: 'This code is invalid or has expired. Please request a new one.',
  RESET_EXHAUSTED: 'Too many incorrect codes. Please request a new one.',
  RESET_LOCKED: 'Too many incorrect codes. Please try again tomorrow.',
  RESET_DONE: 'Password reset successfully',
};

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * firebase-admin error codes that mean this server cannot verify tokens at all
 * (wrong or missing project credentials), as opposed to a bad token. Those are
 * our fault and are reported as 503, not blamed on the caller.
 */
const VERIFIER_CONFIG_ERRORS = new Set(['auth/invalid-credential', 'auth/internal-error']);

const RESET_CODE_TTL_MINUTES = 15;
const RESET_MAX_ATTEMPTS = 5;

/**
 * Per-account limits. RESET_MAX_ATTEMPTS is per code and starts again with
 * every new code, so on its own an attacker spread over many IPs could keep
 * requesting codes and guessing. These do not reset when a code is issued:
 * at most RESET_CODES_PER_WINDOW codes (and so emails) per account per window,
 * and at most RESET_GUESSES_PER_WINDOW guesses per account per day across
 * every code. A successful reset clears the guess count.
 */
const RESET_CODES_PER_WINDOW = 3;
const RESET_CODE_WINDOW_MS = 60 * 60 * 1000;
const RESET_GUESSES_PER_WINDOW = 10;
const RESET_GUESS_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The stored form of a reset code. Salted with the user id so the same code
 * for two accounts never hashes alike, and a copied hash is useless for any
 * other account.
 */
const hashResetCode = (userId, code) =>
  crypto.createHash('sha256').update(`${userId}:${code}`).digest('hex');

/** Constant-time comparison of two hex digests. False for anything malformed. */
const resetCodeMatches = (candidateHex, storedHex) => {
  if (typeof candidateHex !== 'string' || typeof storedHex !== 'string') return false;
  const a = Buffer.from(candidateHex, 'hex');
  const b = Buffer.from(storedHex, 'hex');
  return a.length === 32 && a.length === b.length && crypto.timingSafeEqual(a, b);
};

/** A uniformly random six-digit code, leading zeros kept. */
const generateResetCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

/** A 4xx whose data.code tells the app which recovery to offer. */
const failWithCode = (res, statusCode, message, code) =>
  res.status(statusCode).json({ success: false, message, data: { code } });

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/** A provider photo URL worth keeping: https only, and a sane length. */
const usablePhotoUrl = (url) =>
  typeof url === 'string' && url.startsWith('https://') && url.length <= 2048 ? url : null;

/**
 * @param {object} deps
 * @param {(text: string, params?: any[]) => Promise<{rows: any[], rowCount: number}>} deps.query
 * @param {() => Promise<{query: Function, release: Function}>} deps.getClient
 * @param {() => ({verifyIdToken: (t: string) => Promise<object>}|null)} deps.getAuth firebase-admin auth, or null when not configured
 * @param {(payload: object) => string} deps.generateToken
 * @param {() => boolean} deps.isEmailConfigured
 * @param {(args: {toEmail: string, code: string, expiresInMinutes: number}) => Promise<void>} deps.sendPasswordResetCode
 * @param {(plain: string) => Promise<string>} [deps.hashPassword]
 * @param {() => string} [deps.generateCode]
 * @param {(task: () => Promise<void>) => void} [deps.runInBackground]
 * @param {() => Date} [deps.now]
 */
const buildAuthHandlers = ({
  query,
  getClient,
  getAuth,
  generateToken,
  isEmailConfigured,
  sendPasswordResetCode,
  hashPassword = (plain) => bcrypt.hash(plain, 12),
  generateCode = generateResetCode,
  runInBackground = (task) => { task(); },
  now = () => new Date(),
}) => {
  const signedIn = (res, user, isNewUser) => {
    const token = generateToken({ id: user.id, email: user.email, role: user.role });
    return success(res, { user, token, is_new_user: isNewUser }, 'Login successful');
  };

  const findByFirebaseUid = async (uid) => {
    const result = await query(
      `SELECT ${userColumns('u')}
         FROM user_identities i JOIN users u ON u.id = i.user_id
        WHERE i.firebase_uid = $1`,
      [uid]
    );
    return result.rows[0] || null;
  };

  /**
   * Signs in a user found by firebase_uid: a returning user, or the loser of a
   * race between two first sign-ins of the same person.
   */
  const signInExisting = (res, user) => {
    if (user.status === 'suspended') return error(res, MESSAGES.SUSPENDED, 403);
    return signedIn(res, user, false);
  };

  const verifyFirebaseToken = async (idToken, expectedProvider) => {
    const auth = getAuth();
    if (!auth) return { status: 503 };
    let decoded;
    try {
      decoded = await auth.verifyIdToken(idToken);
    } catch (err) {
      if (VERIFIER_CONFIG_ERRORS.has(err && err.code)) {
        console.error('Firebase token verifier error:', err.code, err.message);
        return { status: 503 };
      }
      // The token itself is never logged.
      console.warn('Firebase sign-in rejected:', (err && err.code) || 'unknown', (err && err.message) || '');
      return { status: 401 };
    }
    const provider = decoded && decoded.firebase && decoded.firebase.sign_in_provider;
    if (provider !== expectedProvider || !isNonEmptyString(decoded.uid)) {
      console.warn(`Firebase sign-in rejected: provider ${provider} at the ${expectedProvider} route`);
      return { status: 401 };
    }
    return { decoded };
  };

  /** Inserts the user, their preferences row and the identity, in one transaction. */
  const createAccount = async ({ name, email, phone, profileImage, provider, uid }) => {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO users (name, email, phone, profile_image, password_hash, auth_provider, role)
         VALUES ($1, $2, $3, $4, NULL, $5, 'user')
         RETURNING ${userColumns()}`,
        [name, email, phone, profileImage, provider]
      );
      const user = inserted.rows[0];
      await client.query('INSERT INTO user_preferences (user_id) VALUES ($1)', [user.id]);
      await client.query(
        'INSERT INTO user_identities (firebase_uid, user_id, provider) VALUES ($1, $2, $3)',
        [uid, user.id, provider]
      );
      await client.query('COMMIT');
      return user;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Firebase sign-in rollback failed:', rollbackErr);
      }
      throw err;
    } finally {
      client.release();
    }
  };

  const firebaseLogin = (provider) => {
    const { signInProvider } = FIREBASE_PROVIDERS[provider];

    return async (req, res) => {
      try {
        const { idToken, name: bodyName } = req.body;

        const verified = await verifyFirebaseToken(idToken, signInProvider);
        if (verified.status === 503) return error(res, MESSAGES.SIGN_IN_UNAVAILABLE, 503);
        if (verified.status === 401) return unauthorized(res, MESSAGES.SIGN_IN_UNVERIFIED);
        const { decoded } = verified;
        const uid = decoded.uid;

        // 1. A returning user: the identity is already known.
        const known = await findByFirebaseUid(uid);
        if (known) return signInExisting(res, known);

        // What the verified token says. Email, name and photo never come from
        // the request body; only a name for a brand-new account may.
        const tokenEmail = provider !== 'phone' && isNonEmptyString(decoded.email)
          ? decoded.email.trim()
          : null;
        const emailVerified = decoded.email_verified === true;

        let phone = null;
        if (provider === 'phone') {
          phone = isNonEmptyString(decoded.phone_number) ? decoded.phone_number.trim() : null;
          // users.phone is VARCHAR(20); E.164 is at most 16 characters.
          if (!phone || phone.length > 20) {
            console.warn('Firebase phone sign-in rejected: token has no usable phone_number');
            return unauthorized(res, MESSAGES.SIGN_IN_UNVERIFIED);
          }
        }

        // 2. The email already belongs to an account. Never linked: /register
        // does not verify addresses, so whoever registered this email first
        // may not own it, and joining the Google sign-in to that account
        // would hand it the real owner's sign-ins.
        if (tokenEmail) {
          const owners = (await query(
            'SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1',
            [tokenEmail]
          )).rows;
          if (owners.length > 0) {
            return failWithCode(res, 409, MESSAGES.EMAIL_IN_USE, 'EMAIL_IN_USE');
          }
        }

        // 3. A new account.
        const tokenName = isPlaceholderName(decoded.name) ? null : normalizeName(decoded.name);
        const givenName = isPlaceholderName(bodyName) ? null : normalizeName(bodyName);
        const name = (tokenName || givenName || '').slice(0, 255);
        if (provider === 'phone' && name === '') {
          return failWithCode(res, 422, MESSAGES.NAME_REQUIRED, 'NAME_REQUIRED');
        }

        // Only an address the provider vouches for is stored. An unverified
        // one would let anyone reserve someone else's email, blocking them
        // from registering it. users.email is VARCHAR(255).
        const email = tokenEmail && emailVerified && tokenEmail.length <= 255 ? tokenEmail : null;

        let user;
        try {
          user = await createAccount({
            name,
            email,
            phone,
            profileImage: usablePhotoUrl(decoded.picture),
            provider,
            uid,
          });
        } catch (err) {
          if (err.code !== UNIQUE_VIOLATION) throw err;
          // A racing first sign-in of this same uid won. The users row goes in
          // before the identity, so with an email the loser trips
          // users_email_key, not user_identities_pkey: look the uid up either way.
          const raced = await findByFirebaseUid(uid);
          if (raced) return signInExisting(res, raced);
          if (err.constraint === 'users_email_key') {
            return failWithCode(res, 409, MESSAGES.EMAIL_IN_USE, 'EMAIL_IN_USE');
          }
          throw err;
        }

        return signedIn(res, user, true);
      } catch (err) {
        console.error(`${provider} sign-in error:`, err);
        return error(res, 'Sign-in failed', 500);
      }
    };
  };

  const forgotPassword = async (req, res) => {
    // Config-level, identical for every address, so it reveals nothing about
    // which accounts exist.
    if (!isEmailConfigured()) {
      return error(res, MESSAGES.RESET_UNAVAILABLE, 503);
    }

    try {
      const { email } = req.body;

      // Same accounts /login accepts: an email+password account that is active.
      const result = await query(
        `SELECT id, email FROM users
          WHERE email = $1 AND auth_provider = 'email' AND status = 'active'`,
        [email]
      );
      if (result.rows.length === 0) {
        return success(res, {}, MESSAGES.RESET_SENT);
      }

      const user = result.rows[0];
      const code = generateCode();
      const codeHash = hashResetCode(user.id, code);
      const at = now();
      const expiresAt = new Date(at.getTime() + RESET_CODE_TTL_MINUTES * 60 * 1000);

      // Issues the code only while this account is under its per-hour code
      // limit and not locked out by wrong guesses. Checked and counted in one
      // statement, so parallel requests cannot all slip in under the limit.
      // SET expressions read the row as it was before the update.
      const codeWindowStart = new Date(at.getTime() - RESET_CODE_WINDOW_MS);
      const guessWindowStart = new Date(at.getTime() - RESET_GUESS_WINDOW_MS);
      const issued = await query(
        `UPDATE users
            SET reset_code_hash = $1, reset_code_expires_at = $2, reset_attempts = 0,
                reset_window_started_at = CASE
                  WHEN reset_window_started_at IS NULL OR reset_window_started_at <= $5 THEN $4
                  ELSE reset_window_started_at END,
                reset_codes_issued = CASE
                  WHEN reset_window_started_at IS NULL OR reset_window_started_at <= $5 THEN 1
                  ELSE reset_codes_issued + 1 END
          WHERE id = $3
            AND (reset_window_started_at IS NULL OR reset_window_started_at <= $5 OR reset_codes_issued < $6)
            AND (reset_guesses_started_at IS NULL OR reset_guesses_started_at <= $7 OR reset_guesses < $8)
          RETURNING id`,
        [codeHash, expiresAt, user.id, at, codeWindowStart, RESET_CODES_PER_WINDOW,
          guessWindowStart, RESET_GUESSES_PER_WINDOW]
      );
      if (issued.rowCount === 0) {
        // Same answer as for any other address; nothing is sent.
        console.warn(`Password reset request refused: per-account limit reached (user ${user.id})`);
        return success(res, {}, MESSAGES.RESET_SENT);
      }

      // Sent after responding, so a registered address does not answer
      // measurably slower than an unknown one. A failed send voids the code
      // it carried; the person asks again.
      runInBackground(async () => {
        try {
          await sendPasswordResetCode({
            toEmail: user.email,
            code,
            expiresInMinutes: RESET_CODE_TTL_MINUTES,
          });
        } catch (err) {
          console.error(`Password reset email failed (user ${user.id}):`, err.message);
          try {
            await query(
              `UPDATE users SET reset_code_hash = NULL, reset_code_expires_at = NULL, reset_attempts = 0
                WHERE id = $1 AND reset_code_hash = $2`,
              [user.id, codeHash]
            );
          } catch (voidErr) {
            console.error(`Voiding an undelivered reset code failed (user ${user.id}):`, voidErr);
          }
        }
      });

      return success(res, {}, MESSAGES.RESET_SENT);
    } catch (err) {
      console.error('Forgot password error:', err);
      return error(res, 'Failed to process request', 500);
    }
  };

  const verifyOtp = async (req, res) => {
    try {
      const { email, otp, new_password } = req.body;

      // Spends one attempt on this code and one of the account's daily
      // guesses before comparing, atomically, so parallel guesses cannot all
      // slip in under either limit.
      const at = now();
      const claimed = await query(
        `UPDATE users SET reset_attempts = reset_attempts + 1,
                reset_guesses_started_at = CASE
                  WHEN reset_guesses_started_at IS NULL OR reset_guesses_started_at <= $4 THEN $2
                  ELSE reset_guesses_started_at END,
                reset_guesses = CASE
                  WHEN reset_guesses_started_at IS NULL OR reset_guesses_started_at <= $4 THEN 1
                  ELSE reset_guesses + 1 END
          WHERE email = $1 AND auth_provider = 'email' AND status = 'active'
            AND reset_code_hash IS NOT NULL
            AND reset_code_expires_at > $2
            AND reset_attempts < $3
            AND (reset_guesses_started_at IS NULL OR reset_guesses_started_at <= $4 OR reset_guesses < $5)
          RETURNING id, reset_code_hash, reset_attempts, reset_guesses`,
        [email, at, RESET_MAX_ATTEMPTS, new Date(at.getTime() - RESET_GUESS_WINDOW_MS), RESET_GUESSES_PER_WINDOW]
      );
      if (claimed.rows.length === 0) {
        return error(res, MESSAGES.RESET_INVALID, 400);
      }

      const row = claimed.rows[0];
      if (!resetCodeMatches(hashResetCode(row.id, otp), row.reset_code_hash)) {
        const lockedOut = row.reset_guesses >= RESET_GUESSES_PER_WINDOW;
        if (lockedOut || row.reset_attempts >= RESET_MAX_ATTEMPTS) {
          await query(
            `UPDATE users SET reset_code_hash = NULL, reset_code_expires_at = NULL
              WHERE id = $1 AND reset_code_hash = $2`,
            [row.id, row.reset_code_hash]
          );
          return error(res, lockedOut ? MESSAGES.RESET_LOCKED : MESSAGES.RESET_EXHAUSTED, 400);
        }
        const left = RESET_MAX_ATTEMPTS - row.reset_attempts;
        return error(res, `Incorrect code. ${left} ${left === 1 ? 'attempt' : 'attempts'} left.`, 400);
      }

      const password_hash = await hashPassword(new_password);

      // Consumes the code. Conditional on it still being the same code, so
      // two correct submissions at once reset the password only once, and a
      // code replaced by a newer request in the meantime no longer works.
      const consumed = await query(
        `UPDATE users
            SET password_hash = $1, reset_code_hash = NULL, reset_code_expires_at = NULL,
                reset_attempts = 0, reset_guesses = 0, reset_guesses_started_at = NULL,
                updated_at = NOW()
          WHERE id = $2 AND reset_code_hash = $3`,
        [password_hash, row.id, row.reset_code_hash]
      );
      if (consumed.rowCount === 0) {
        return error(res, MESSAGES.RESET_INVALID, 400);
      }

      return success(res, {}, MESSAGES.RESET_DONE);
    } catch (err) {
      console.error('OTP verify error:', err);
      return error(res, 'OTP verification failed', 500);
    }
  };

  return {
    googleLogin: firebaseLogin('google'),
    facebookLogin: firebaseLogin('facebook'),
    phoneLogin: firebaseLogin('phone'),
    forgotPassword,
    verifyOtp,
  };
};

const { googleLogin, facebookLogin, phoneLogin, forgotPassword, verifyOtp } = buildAuthHandlers({
  query,
  getClient,
  getAuth: firebase.getAuth,
  generateToken,
  isEmailConfigured: emailService.isEmailConfigured,
  sendPasswordResetCode: emailService.sendPasswordResetCode,
});

const logout = async (req, res) => {
  // JWT is stateless — instruct client to delete the token
  return success(res, {}, 'Logged out successfully');
};

module.exports = {
  register,
  login,
  forgotPassword,
  verifyOtp,
  logout,
  googleLogin,
  facebookLogin,
  phoneLogin,
  buildAuthHandlers,
  hashResetCode,
  resetCodeMatches,
  generateResetCode,
  MESSAGES,
  RESET_MAX_ATTEMPTS,
  RESET_CODE_TTL_MINUTES,
  RESET_CODES_PER_WINDOW,
  RESET_GUESSES_PER_WINDOW,
};
