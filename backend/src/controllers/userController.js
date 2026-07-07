const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const { getStorage } = require('../config/firebase');
const { success, error, notFound } = require('../utils/response');

const getProfile = async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, email, phone, emergency_contact, user_type, profile_image, role, status, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (result.rows.length === 0) return notFound(res, 'User not found');
    return success(res, { user: result.rows[0] });
  } catch (err) {
    console.error('Get profile error:', err);
    return error(res, 'Failed to fetch profile', 500);
  }
};

const updateProfile = async (req, res) => {
  try {
    const { name, phone, emergency_contact, current_password, new_password } = req.body;
    const userId = req.user.id;

    // Handle profile image upload to Firebase Storage
    let profile_image_url = null;
    if (req.file) {
      const bucket = getStorage();
      if (!bucket) return error(res, 'Storage not configured', 503);

      const filename = `profile_images/${userId}_${Date.now()}`;
      const file = bucket.file(filename);

      await file.save(req.file.buffer, {
        metadata: { contentType: req.file.mimetype },
      });
      await file.makePublic();
      profile_image_url = `https://storage.googleapis.com/${bucket.name}/${filename}`;
    }

    // Handle password change
    if (new_password) {
      if (!current_password) {
        return error(res, 'current_password is required to set a new password', 400);
      }

      const userResult = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
      const valid = await bcrypt.compare(current_password, userResult.rows[0].password_hash);
      if (!valid) {
        return error(res, 'Current password is incorrect', 400);
      }

      const password_hash = await bcrypt.hash(new_password, 12);
      await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [password_hash, userId]);
    }

    const result = await query(
      `UPDATE users
       SET name              = COALESCE($1, name),
           phone             = COALESCE($2, phone),
           emergency_contact = COALESCE($3, emergency_contact),
           profile_image     = COALESCE($4, profile_image),
           updated_at        = NOW()
       WHERE id = $5
       RETURNING id, name, email, phone, emergency_contact, user_type, profile_image, role, status`,
      [name || null, phone || null, emergency_contact || null, profile_image_url, userId]
    );

    return success(res, { user: result.rows[0] }, 'Profile updated');
  } catch (err) {
    console.error('Update profile error:', err);
    return error(res, 'Failed to update profile', 500);
  }
};

const getPreferences = async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM user_preferences WHERE user_id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) return notFound(res, 'Preferences not found');
    return success(res, { preferences: result.rows[0] });
  } catch (err) {
    console.error('Get preferences error:', err);
    return error(res, 'Failed to fetch preferences', 500);
  }
};

const updatePreferences = async (req, res) => {
  try {
    const {
      alert_police, alert_construction, alert_hazards,
      alert_traffic, alert_business, alert_tourism, priority_level,
    } = req.body;

    const result = await query(
      `UPDATE user_preferences
       SET alert_police = COALESCE($1, alert_police),
           alert_construction = COALESCE($2, alert_construction),
           alert_hazards = COALESCE($3, alert_hazards),
           alert_traffic = COALESCE($4, alert_traffic),
           alert_business = COALESCE($5, alert_business),
           alert_tourism = COALESCE($6, alert_tourism),
           priority_level = COALESCE($7, priority_level),
           updated_at = NOW()
       WHERE user_id = $8
       RETURNING *`,
      [alert_police, alert_construction, alert_hazards, alert_traffic,
       alert_business, alert_tourism, priority_level, req.user.id]
    );
    return success(res, { preferences: result.rows[0] }, 'Preferences updated');
  } catch (err) {
    console.error('Update preferences error:', err);
    return error(res, 'Failed to update preferences', 500);
  }
};

module.exports = { getProfile, updateProfile, getPreferences, updatePreferences };
