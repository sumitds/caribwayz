/**
 * Adding someone to a group: the one set of rules for joining, whether by the
 * join code (POST /groups/join) or by accepting an invite in the app
 * (POST /groups/invites/:id/accept).
 *
 *  - Someone an active member blocked cannot join: they would otherwise be
 *    one step away from that member's live location. The answer does not say
 *    who blocked them.
 *  - An active member is already in; nothing changes.
 *  - Someone who left comes back on their old row; anyone else gets a new one.
 *
 * Joining also answers any pending invite to that group for that person, so
 * an invite never stays on their list once they are in.
 */

const JOINED = 'joined';
const BLOCKED = 'blocked';
const ALREADY_MEMBER = 'already_member';

/** What the person is told for each refusal; the same words on both paths. */
const BLOCKED_MESSAGE = "You can't join this group.";
const ALREADY_MEMBER_MESSAGE = 'You are already a member of this group';

/**
 * Adds [userId] to [groupId] through [run], which is the pool query or a
 * transaction client's query. [latitude] and [longitude] are where the person
 * is, or null/undefined when the phone did not say.
 *
 * Returns JOINED, BLOCKED or ALREADY_MEMBER. Throws on a database error, so a
 * caller inside a transaction can roll back.
 */
const addMember = async (run, { groupId, userId, latitude, longitude }) => {
  const blockedBy = await run(
    `SELECT 1 FROM group_members gm
       JOIN user_blocks ub ON ub.blocker_id = gm.user_id
      WHERE gm.group_id = $1 AND gm.status = 'active' AND ub.blocked_id = $2
      LIMIT 1`,
    [groupId, userId]
  );
  if (blockedBy.rows.length > 0) return BLOCKED;

  const existing = await run(
    'SELECT id, status FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );

  if (existing.rows.length > 0) {
    if (existing.rows[0].status === 'active') return ALREADY_MEMBER;
    await run(
      `UPDATE group_members
       SET status = 'active', joined_at = NOW(),
           current_latitude = $1, current_longitude = $2, location_updated_at = NOW()
       WHERE group_id = $3 AND user_id = $4`,
      [latitude ?? null, longitude ?? null, groupId, userId]
    );
  } else {
    await run(
      `INSERT INTO group_members (group_id, user_id, current_latitude, current_longitude, location_updated_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [groupId, userId, latitude ?? null, longitude ?? null, latitude ? new Date() : null]
    );
  }

  await run(
    `UPDATE group_invites SET status = 'accepted', responded_at = NOW()
      WHERE group_id = $1 AND invitee_id = $2 AND status = 'pending'`,
    [groupId, userId]
  );
  return JOINED;
};

module.exports = {
  addMember,
  JOINED,
  BLOCKED,
  ALREADY_MEMBER,
  BLOCKED_MESSAGE,
  ALREADY_MEMBER_MESSAGE,
};
