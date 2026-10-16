/**
 * Blocking another person (table user_blocks, migration 023).
 *
 * A block hides the two people from each other in every group they share:
 * neither receives the other's live location, SOS or check-in, by socket or by
 * notification, and neither appears in the other's member list. It also stops
 * the blocked person joining a group the blocker is in, and stops either one
 * inviting the other. Only the person who blocked can see or undo the block.
 *
 * These helpers return SQL fragments so each caller keeps its single query;
 * [ref] and [other] are SQL expressions (a "$2" placeholder or a column).
 */

/** Ids of everyone [ref] has blocked or been blocked by, as a subquery. */
const blockedWithSubquery = (ref) =>
  `(SELECT blocked_id FROM user_blocks WHERE blocker_id = ${ref}
    UNION
    SELECT blocker_id FROM user_blocks WHERE blocked_id = ${ref})`;

/** True when neither of [a] and [b] has blocked the other. */
const notBlockedBetween = (a, b) =>
  `NOT EXISTS (SELECT 1 FROM user_blocks ub
                WHERE (ub.blocker_id = ${a} AND ub.blocked_id = ${b})
                   OR (ub.blocker_id = ${b} AND ub.blocked_id = ${a}))`;

/** A Postgres uuid[] column as an array of strings; [] when absent. */
const idList = (value) => (Array.isArray(value) ? value.map(String) : []);

module.exports = { blockedWithSubquery, notBlockedBetween, idList };
