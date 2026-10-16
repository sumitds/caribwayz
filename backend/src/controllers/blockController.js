const db = require('../config/db');
const { success, error, notFound } = require('../utils/response');
const { displayName } = require('../utils/displayName');

/**
 * The people the caller has blocked, and blocking or unblocking one of them.
 * What a block does is in services/blockService.js.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres foreign_key_violation: the person was deleted between the check and the insert. */
const FOREIGN_KEY_VIOLATION = '23503';

/** A blocked person as the app shows them: no email, phone or location. */
const toBlockedPerson = (row) => ({
  user_id: row.user_id,
  name: displayName(row.name),
  profile_image: row.profile_image || null,
  blocked_at: row.blocked_at,
});

/**
 * @param {object} deps
 * @param {(text: string, params?: any[]) => Promise<{rows: any[], rowCount: number}>} deps.query
 */
const buildBlockHandlers = ({ query }) => {
  const listBlocked = async (req, res) => {
    try {
      const result = await query(
        `SELECT b.blocked_id AS user_id, u.name, u.profile_image, b.created_at AS blocked_at
           FROM user_blocks b
           JOIN users u ON u.id = b.blocked_id
          WHERE b.blocker_id = $1
          ORDER BY b.created_at DESC`,
        [req.user.id]
      );
      return success(res, { blocked: result.rows.map(toBlockedPerson) });
    } catch (err) {
      console.error(`List blocked people error (user ${req.user && req.user.id}):`, err);
      return error(res, 'Failed to load the people you blocked', 500);
    }
  };

  const blockUser = async (req, res) => {
    const body = req.body || {};
    const targetId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
    try {
      if (!UUID_PATTERN.test(targetId)) return error(res, 'user_id must be a valid UUID', 400);
      if (targetId.toLowerCase() === String(req.user.id).toLowerCase()) {
        return error(res, "You can't block yourself", 400);
      }

      const target = await query('SELECT id, name, profile_image FROM users WHERE id = $1', [targetId]);
      if (target.rows.length === 0) return notFound(res, 'User not found');

      // Blocking twice is not an error: the person is blocked either way, and
      // the original date is kept.
      const saved = await query(
        `INSERT INTO user_blocks (blocker_id, blocked_id)
         VALUES ($1, $2)
         ON CONFLICT (blocker_id, blocked_id) DO UPDATE SET blocker_id = EXCLUDED.blocker_id
         RETURNING created_at`,
        [req.user.id, targetId]
      );

      const person = toBlockedPerson({
        user_id: target.rows[0].id,
        name: target.rows[0].name,
        profile_image: target.rows[0].profile_image,
        blocked_at: saved.rows[0].created_at,
      });
      return success(res, { blocked: person }, `${person.name} is blocked`);
    } catch (err) {
      if (err.code === FOREIGN_KEY_VIOLATION) return notFound(res, 'User not found');
      console.error(`Block user error (user ${req.user && req.user.id}, target ${targetId}):`, err);
      return error(res, 'Failed to block this person', 500);
    }
  };

  /**
   * A person who is not blocked is not an error: the goal of the request is
   * already met, and a second tap on a slow connection must not show a failure.
   */
  const unblockUser = async (req, res) => {
    const targetId = String(req.params.user_id || '');
    try {
      if (!UUID_PATTERN.test(targetId)) return error(res, 'user_id must be a valid UUID', 400);
      const result = await query(
        'DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2',
        [req.user.id, targetId]
      );
      const unblocked = result.rowCount > 0;
      return success(res, { unblocked }, unblocked ? 'Unblocked' : 'This person was not blocked');
    } catch (err) {
      console.error(`Unblock user error (user ${req.user && req.user.id}, target ${targetId}):`, err);
      return error(res, 'Failed to unblock this person', 500);
    }
  };

  return { listBlocked, blockUser, unblockUser };
};

const { listBlocked, blockUser, unblockUser } = buildBlockHandlers({ query: db.query });

module.exports = { buildBlockHandlers, listBlocked, blockUser, unblockUser };
