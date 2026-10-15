const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const { getStorage } = require('../config/firebase');
const { success, error, notFound } = require('../utils/response');
const weatherAlerts = require('../services/weatherAlertService');
const { isSessionId, notifySessionsRevoked } = require('../services/sessionService');
const { normalizeContactPhone } = require('../utils/phone');

const getProfile = async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, email, phone, emergency_contact, emergency_contacts, user_type, profile_image, role, status, created_at
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
      const stored = userResult.rows[0];
      if (!stored) return notFound(res, 'User not found');
      // Google, Facebook and phone accounts are created without a password.
      if (!stored.password_hash) {
        return error(res, 'This account signs in with Google, Facebook or phone and has no password to change', 400);
      }
      const valid = await bcrypt.compare(current_password, stored.password_hash);
      if (!valid) {
        return error(res, 'Current password is incorrect', 400);
      }

      // Every other device is signed out before the password changes; this
      // one stays signed in. A token from before sign-in history has no
      // session to keep, so every recorded session ends.
      const keep = isSessionId(req.user.sid) ? req.user.sid : null;
      const revoked = await query(
        `UPDATE user_sessions SET revoked_at = NOW()
          WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)
          RETURNING id`,
        [userId, keep]
      );
      notifySessionsRevoked(revoked.rows.map((r) => r.id));

      const password_hash = await bcrypt.hash(new_password, 12);
      await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [password_hash, userId]);
    }

    // The route has already refused a number that is not one. Edit Profile's
    // Emergency Contact is the first trusted contact: it replaces the first
    // entry of the list, and the same number further down is dropped.
    const primaryContact = emergency_contact ? normalizeContactPhone(emergency_contact) : null;

    const result = await query(
      `UPDATE users
       SET name               = COALESCE($1, name),
           phone              = COALESCE($2, phone),
           emergency_contact  = COALESCE($3::text, emergency_contact),
           emergency_contacts = CASE WHEN $3::text IS NULL THEN emergency_contacts
             ELSE ARRAY[$3::text] || ARRAY(
               SELECT c FROM unnest(emergency_contacts[2:]) WITH ORDINALITY AS t(c, n)
                WHERE regexp_replace(c, '[^0-9]', '', 'g') <> regexp_replace($3::text, '[^0-9]', '', 'g')
                ORDER BY n)
           END,
           profile_image      = COALESCE($4, profile_image),
           updated_at         = NOW()
       WHERE id = $5
       RETURNING id, name, email, phone, emergency_contact, emergency_contacts, user_type, profile_image, role, status`,
      [name || null, phone || null, primaryContact, profile_image_url, userId]
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
      push_emergency, push_group, push_reports, push_app_updates, push_promotions, push_weather,
    } = req.body;

    // Every field is optional: an omitted one keeps its stored value, so the
    // app can flip one switch without re-sending the rest.
    const result = await query(
      `UPDATE user_preferences
       SET alert_police = COALESCE($1, alert_police),
           alert_construction = COALESCE($2, alert_construction),
           alert_hazards = COALESCE($3, alert_hazards),
           alert_traffic = COALESCE($4, alert_traffic),
           alert_business = COALESCE($5, alert_business),
           alert_tourism = COALESCE($6, alert_tourism),
           priority_level = COALESCE($7, priority_level),
           push_emergency = COALESCE($9, push_emergency),
           push_group = COALESCE($10, push_group),
           push_reports = COALESCE($11, push_reports),
           push_app_updates = COALESCE($12, push_app_updates),
           push_promotions = COALESCE($13, push_promotions),
           push_weather = COALESCE($14, push_weather),
           updated_at = NOW()
       WHERE user_id = $8
       RETURNING *`,
      [alert_police, alert_construction, alert_hazards, alert_traffic,
       alert_business, alert_tourism, priority_level, req.user.id,
       push_emergency, push_group, push_reports, push_app_updates, push_promotions, push_weather]
    );
    // Without this the app would be told its switch was saved when nothing was.
    if (result.rows.length === 0) return notFound(res, 'Preferences not found');
    // The rough area is kept only for weather alerts, so it goes with them.
    // The switch is already saved, so a failure here is logged and the answer
    // still says what was saved; the area is no longer used for alerts
    // either way, as recipients skip anyone with push_weather off.
    if (push_weather === false) {
      try {
        await weatherAlerts.clearAlertArea(req.user.id);
      } catch (err) {
        console.error(`Clearing the weather alert area failed (user ${req.user.id}):`, err.message);
      }
    }
    return success(res, { preferences: result.rows[0] }, 'Preferences updated');
  } catch (err) {
    console.error('Update preferences error:', err);
    return error(res, 'Failed to update preferences', 500);
  }
};

/**
 * Only the newest registrations of an account are kept, so reinstalls do not
 * pile up dead tokens that every notification would be sent to.
 */
const MAX_DEVICES_PER_USER = 10;

/**
 * Registers this phone for push. A token belongs to one app install, so when it
 * is already registered to another account (someone else signed in on this
 * phone before) it moves to the caller: the previous account must stop getting
 * pushes on a phone it is no longer signed in on.
 */
const registerDeviceToken = async (req, res) => {
  try {
    const { token, platform } = req.body;
    // previous_owner is read from the snapshot before the upsert, so it is the
    // account the token belonged to until now (null for a new token).
    const result = await query(
      `WITH previous AS (SELECT user_id FROM device_tokens WHERE token = $2)
       INSERT INTO device_tokens (user_id, token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             platform = EXCLUDED.platform,
             updated_at = NOW()
       RETURNING id, token, platform, created_at, updated_at,
                 (SELECT user_id FROM previous) AS previous_owner`,
      [req.user.id, token, platform]
    );
    const { previous_owner: previousOwner, ...deviceToken } = result.rows[0];
    // Nothing proves the caller holds this install, so a move between accounts
    // is logged with both ids: a responder who stops getting pushes can be
    // traced to the account that took their token.
    if (previousOwner && previousOwner !== req.user.id) {
      console.warn(`Device token ${deviceToken.id} moved from user ${previousOwner} to user ${req.user.id}`);
    }

    await query(
      `DELETE FROM device_tokens
        WHERE user_id = $1
          AND id NOT IN (
            SELECT id FROM device_tokens
             WHERE user_id = $1
             ORDER BY updated_at DESC, created_at DESC
             LIMIT $2
          )`,
      [req.user.id, MAX_DEVICES_PER_USER]
    );

    return success(res, { device_token: deviceToken }, 'Device registered for notifications');
  } catch (err) {
    console.error(`Register device token error (user ${req.user && req.user.id}):`, err);
    return error(res, 'Failed to register this device for notifications', 500);
  }
};

/**
 * Unregisters this phone, on sign-out. Only the caller's own token is removed,
 * so nobody can switch off another person's pushes by sending their token. A
 * token that is not registered to the caller is not an error: sign-out must
 * succeed whether or not registration ever did.
 */
const removeDeviceToken = async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM device_tokens WHERE token = $1 AND user_id = $2',
      [req.body.token, req.user.id]
    );
    const removed = result.rowCount > 0;
    return success(
      res,
      { removed },
      removed ? 'Device removed from notifications' : 'Device was not registered for notifications'
    );
  } catch (err) {
    console.error(`Remove device token error (user ${req.user && req.user.id}):`, err);
    return error(res, 'Failed to remove this device from notifications', 500);
  }
};

/**
 * Records the rough area the app is in, for weather alerts. Stored only while
 * the caller's weather alerts are on (rounded to about 11 km); otherwise
 * nothing is kept and stored is false.
 */
const updateAlertArea = async (req, res) => {
  try {
    const stored = await weatherAlerts.setAlertArea(req.user.id, req.body.latitude, req.body.longitude);
    return success(
      res,
      { stored },
      stored ? 'Area saved for weather alerts' : 'Weather alerts are off, so the area was not saved'
    );
  } catch (err) {
    console.error(`Update alert area error (user ${req.user && req.user.id}):`, err.message);
    return error(res, 'Failed to save your area for weather alerts', 500);
  }
};

module.exports = {
  getProfile, updateProfile, getPreferences, updatePreferences,
  registerDeviceToken, removeDeviceToken, updateAlertArea, MAX_DEVICES_PER_USER,
};
