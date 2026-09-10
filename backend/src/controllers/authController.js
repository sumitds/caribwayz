const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const { generateToken } = require('../utils/jwt');
const { success, created, error, unauthorized } = require('../utils/response');

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

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    const result = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      // Don't reveal if email exists
      return success(res, {}, 'If this email is registered, you will receive an OTP shortly');
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    await query(
      'UPDATE users SET otp_code = $1, otp_expires_at = $2 WHERE email = $3',
      [otp, expiresAt, email]
    );

    // TODO: integrate SMS/email service — OTP returned in response for development
    console.log(`OTP for ${email}: ${otp}`);

    return success(res, { otp }, 'OTP generated successfully');
  } catch (err) {
    console.error('Forgot password error:', err);
    return error(res, 'Failed to process request', 500);
  }
};

const verifyOtp = async (req, res) => {
  try {
    const { email, otp, new_password } = req.body;

    const result = await query(
      `SELECT id, otp_code, otp_expires_at FROM users WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return error(res, 'Invalid request', 400);
    }

    const user = result.rows[0];

    if (!user.otp_code || user.otp_code !== otp) {
      return error(res, 'Invalid OTP', 400);
    }

    if (new Date() > new Date(user.otp_expires_at)) {
      return error(res, 'OTP has expired', 400);
    }

    const password_hash = await bcrypt.hash(new_password, 12);

    await query(
      'UPDATE users SET password_hash = $1, otp_code = NULL, otp_expires_at = NULL WHERE id = $2',
      [password_hash, user.id]
    );

    return success(res, {}, 'Password reset successfully');
  } catch (err) {
    console.error('OTP verify error:', err);
    return error(res, 'OTP verification failed', 500);
  }
};

const logout = async (req, res) => {
  // JWT is stateless — instruct client to delete the token
  return success(res, {}, 'Logged out successfully');
};

module.exports = { register, login, forgotPassword, verifyOtp, logout };
