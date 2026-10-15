const bcrypt = require('bcryptjs');
const db = require('../config/db');
const ws = require('../services/wsService');
const firebase = require('../config/firebase');
const { buildNotificationService } = require('../services/notificationService');
const { success, error, notFound, forbidden } = require('../utils/response');

/**
 * Account self-service: download personal data and delete the account.
 *
 * Both app stores require in-app account deletion, and the privacy screen
 * promised a data download. Deletion relies on the ON DELETE CASCADE / SET NULL
 * foreign keys every user-owned table already declares, so one DELETE removes
 * the account and everything that is only theirs.
 */

/** Postgres "relation does not exist": a lazily created table nobody has used yet. */
const UNDEFINED_TABLE = '42P01';

/** Fields of users that are never exported: credentials and one-time codes. */
const PROFILE_COLUMNS = `id, name, email, phone, emergency_contact, emergency_contacts, user_type, auth_provider,
  profile_image, role, status, is_responder, responder_approved_at, created_at, updated_at`;

/**
 * What a person gets back about themselves, one entry per section. Only rows
 * that are theirs, and never another member's location, name or contact.
 */
const EXPORT_SECTIONS = [
  ['preferences', 'SELECT * FROM user_preferences WHERE user_id = $1'],
  ['saved_routes', `SELECT r.*, COALESCE(
      (SELECT json_agg(s ORDER BY s.sequence_order) FROM route_stops s WHERE s.route_id = r.id), '[]'::json) AS stops
     FROM routes r WHERE r.user_id = $1 ORDER BY r.created_at`],
  ['road_reports', 'SELECT * FROM reports WHERE user_id = $1 ORDER BY created_at'],
  ['report_confirmations', 'SELECT report_id, created_at FROM report_confirmations WHERE user_id = $1 ORDER BY created_at'],
  ['emergency_alerts', 'SELECT * FROM emergency_alerts WHERE user_id = $1 ORDER BY created_at'],
  ['incident_records', 'SELECT * FROM incident_records WHERE user_id = $1 ORDER BY created_at'],
  ['group_memberships', `SELECT g.id AS group_id, g.group_name, (g.created_by = $1) AS created_by_me,
       gm.status, gm.joined_at, gm.current_latitude AS my_last_latitude,
       gm.current_longitude AS my_last_longitude, gm.location_updated_at AS my_location_updated_at
     FROM group_members gm JOIN groups g ON g.id = gm.group_id
     WHERE gm.user_id = $1 ORDER BY gm.joined_at`],
  // Only whom this person blocked. Who blocked them is the other person's data.
  ['blocked_people', 'SELECT blocked_id AS user_id, created_at AS blocked_at FROM user_blocks WHERE blocker_id = $1 ORDER BY created_at'],
  ['notifications', 'SELECT id, title, message, type, reference_id, is_read, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at'],
  ['businesses_created', 'SELECT * FROM businesses WHERE created_by = $1 ORDER BY created_at'],
  ['sponsorships', 'SELECT * FROM sponsorships WHERE user_id = $1 ORDER BY created_at'],
  ['payouts', 'SELECT id, amount, method, account_detail, status, requested_at, processed_at, note, created_at FROM payouts WHERE user_id = $1 ORDER BY created_at'],
  ['weather_alert_area', 'SELECT latitude, longitude, updated_at FROM user_alert_areas WHERE user_id = $1'],
  ['weather_alerts_sent', 'SELECT alert_key, sent_at FROM weather_alert_deliveries WHERE user_id = $1 ORDER BY sent_at'],
  ['sign_ins', 'SELECT method, platform, created_at, expires_at, revoked_at FROM user_sessions WHERE user_id = $1 ORDER BY created_at'],
];

/** The literal a caller must send to delete, so a stray request cannot. */
const DELETE_CONFIRMATION = 'DELETE';

/**
 * Pulls the object path out of a profile image URL this API wrote
 * (https://storage.googleapis.com/<bucket>/profile_images/<file>). Anything
 * else, such as a URL from a social login provider, is not ours to delete.
 */
const ownedStoragePath = (url, bucketName) => {
  if (typeof url !== 'string' || !bucketName) return null;
  const prefix = `https://storage.googleapis.com/${bucketName}/`;
  if (!url.startsWith(prefix)) return null;
  const path = decodeURIComponent(url.slice(prefix.length).split('?')[0]);
  return path.startsWith('profile_images/') && !path.includes('..') ? path : null;
};

/**
 * @param {object} deps
 * @param {(text: string, params?: any[]) => Promise<{rows: any[], rowCount: number}>} deps.query
 * @param {() => Promise<{query: Function, release: Function}>} deps.getClient
 * @param {(groupId: string, payload: object) => number} deps.broadcastToGroup
 * @param {() => any} deps.getStorage   firebase-admin storage, or null when not configured
 * @param {() => any} deps.getRealtimeDB firebase-admin database, or null when not configured
 * @param {(plain: string, hash: string) => Promise<boolean>} [deps.comparePassword]
 * @param {() => Date} [deps.now]
 * @param {{insertNotifications: Function, sendPush: Function}} [deps.notifications]
 *   notificationService; by default built on [deps.query]
 */
const buildAccountHandlers = ({
  query,
  getClient,
  broadcastToGroup,
  getStorage,
  getRealtimeDB,
  comparePassword = bcrypt.compare,
  now = () => new Date(),
  notifications = buildNotificationService({ query, getMessaging: firebase.getMessaging }),
}) => {
  const exportData = async (req, res) => {
    try {
      const profile = await query(`SELECT ${PROFILE_COLUMNS} FROM users WHERE id = $1`, [req.user.id]);
      if (profile.rows.length === 0) return notFound(res, 'User not found');

      const data = {
        format: 'caribwayz-personal-data',
        version: 1,
        exported_at: now().toISOString(),
        profile: profile.rows[0],
      };
      for (const [section, sql] of EXPORT_SECTIONS) {
        try {
          data[section] = (await query(sql, [req.user.id])).rows;
        } catch (err) {
          // A table that has never been created holds no data for anyone.
          if (err.code !== UNDEFINED_TABLE) throw err;
          data[section] = [];
        }
      }

      const day = data.exported_at.slice(0, 10);
      res.setHeader('Content-Disposition', `attachment; filename="caribwayz-data-${day}.json"`);
      res.setHeader('Cache-Control', 'no-store');
      return success(res, data, 'Personal data export');
    } catch (err) {
      console.error(`Export personal data error (user ${req.user && req.user.id}):`, err);
      return error(res, 'Failed to export your data', 500);
    }
  };

  /** The notice members of a deleted group get, as when a creator deletes it. */
  const groupDeletedNotice = (group) => ({
    type: 'group',
    category: 'group',
    title: 'Group deleted',
    message: `${group.group_name} was deleted by its creator`,
    reference_id: group.id,
  });

  /** Best-effort clean-up of copies outside Postgres. Never throws. */
  const removeExternalCopies = async (userId, profileImage, memberGroupIds) => {
    const storage = getStorage();
    if (storage) {
      try {
        const bucket = storage.bucket();
        const path = ownedStoragePath(profileImage, bucket.name);
        if (path) await bucket.file(path).delete({ ignoreNotFound: true });
      } catch (err) {
        console.error(`Account delete: profile image removal failed for user ${userId}:`, err.message);
      }
    }
    const rtdb = getRealtimeDB();
    if (rtdb) {
      for (const groupId of memberGroupIds) {
        try {
          await rtdb.ref(`groups/${groupId}/locations/${userId}`).remove();
        } catch (err) {
          console.error(`Account delete: live location removal failed for user ${userId}, group ${groupId}:`, err.message);
        }
      }
    }
  };

  const deleteAccount = async (req, res) => {
    const userId = req.user.id;
    const body = req.body || {};
    try {
      if (body.confirm !== DELETE_CONFIRMATION) {
        return error(res, `Send confirm: "${DELETE_CONFIRMATION}" to delete your account`, 400);
      }

      const found = await query(
        'SELECT id, role, password_hash, profile_image FROM users WHERE id = $1',
        [userId]
      );
      if (found.rows.length === 0) return notFound(res, 'User not found');
      const user = found.rows[0];

      // An administrator is removed by another administrator in the panel, so
      // a lost phone cannot take the last admin account with it.
      if (user.role === 'admin') {
        return forbidden(res, 'Administrator accounts cannot be deleted from the app');
      }

      // A stolen unlocked phone holds a valid token; the password is asked
      // again for accounts that have one. 403, not 401: the session is valid
      // and the app must not sign the person out over a typo.
      if (user.password_hash) {
        if (typeof body.password !== 'string' || body.password.length === 0) {
          return error(res, 'Enter your password to delete your account', 400);
        }
        if (!(await comparePassword(body.password, user.password_hash))) {
          return forbidden(res, 'Password is incorrect');
        }
      }

      const client = await getClient();
      let ownedGroups;
      let memberGroupIds;
      try {
        await client.query('BEGIN');

        // Groups this person created cascade away with the account. Read who
        // else is in them first, and leave those members a notice, exactly as
        // when a creator deletes a group.
        ownedGroups = (await client.query(
          `SELECT g.id, g.group_name,
                  COALESCE(array_agg(gm.user_id) FILTER (WHERE gm.user_id IS NOT NULL), '{}') AS others
             FROM groups g
             LEFT JOIN group_members gm
               ON gm.group_id = g.id AND gm.status = 'active' AND gm.user_id <> $1
            WHERE g.created_by = $1
            GROUP BY g.id, g.group_name`,
          [userId]
        )).rows;

        memberGroupIds = (await client.query(
          'SELECT group_id FROM group_members WHERE user_id = $1',
          [userId]
        )).rows.map((r) => r.group_id);

        // The rows are written inside the transaction so a delete that rolls
        // back leaves no notice behind; the push goes only after the commit.
        for (const group of ownedGroups) {
          if (group.others.length === 0) continue;
          await notifications.insertNotifications(
            (text, params) => client.query(text, params),
            group.others,
            groupDeletedNotice(group)
          );
        }

        const deleted = await client.query('DELETE FROM users WHERE id = $1', [userId]);
        if (deleted.rowCount === 0) {
          await client.query('ROLLBACK');
          return notFound(res, 'User not found');
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      // Only after the commit, so no member drops a group whose delete failed.
      for (const group of ownedGroups) {
        broadcastToGroup(group.id, { type: 'group_deleted', group_id: group.id, deleted_by: userId });
        if (group.others.length > 0) await notifications.sendPush(group.others, groupDeletedNotice(group));
      }
      await removeExternalCopies(userId, user.profile_image, memberGroupIds);

      return success(res, { groups_deleted: ownedGroups.length }, 'Your account has been deleted');
    } catch (err) {
      console.error(`Delete account error (user ${userId}):`, err);
      return error(res, 'Failed to delete your account', 500);
    }
  };

  return { exportData, deleteAccount };
};

const { exportData, deleteAccount } = buildAccountHandlers({
  query: db.query,
  getClient: db.getClient,
  broadcastToGroup: ws.broadcastToGroup,
  getStorage: firebase.getStorage,
  getRealtimeDB: firebase.getRealtimeDB,
});

module.exports = {
  buildAccountHandlers,
  exportData,
  deleteAccount,
  ownedStoragePath,
  EXPORT_SECTIONS,
  DELETE_CONFIRMATION,
};
