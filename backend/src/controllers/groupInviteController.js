const db = require('../config/db');
const firebase = require('../config/firebase');
const { buildNotificationService } = require('../services/notificationService');
const { success, error, notFound, forbidden } = require('../utils/response');
const { notBlockedBetween } = require('../services/blockService');
const {
  addMember, JOINED, BLOCKED, BLOCKED_MESSAGE, ALREADY_MEMBER_MESSAGE,
} = require('../services/groupMembership');

/**
 * Group invites inside the app (table group_invites, migration 028).
 *
 * An invite by email (POST /groups/:id/invite) still mails the join code to
 * every address. An address that belongs to a CaribWayz account also gets an
 * invite here, with a notification and a push: "[Name] invited you to join
 * [Group]", which the app answers with Join or Decline. Join adds the person
 * by the same rules as the join code (services/groupMembership.js).
 *
 * Joining shows the group where everyone is, so the in-app invite goes only to
 * an account that has proved it owns the address (users.email_verified,
 * migration 031) and is the only active account with it, ignoring case.
 * Anyone can register an address they do not own; such an account still gets
 * nothing here, and the real owner still gets the email.
 *
 * Only the invitee sees or answers an invite. To anyone else an invite id
 * answers 404, as an id that does not exist does, so ids reveal nothing.
 *
 * An invite lasts INVITE_LIFETIME_DAYS from when it was sent (or last sent
 * again). One older than that is left off the list and answered as expired.
 * Deleting the group, or either account, deletes the invite with it.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long an invite can be answered. */
const INVITE_LIFETIME_DAYS = 7;

/** notifications.title is VARCHAR(255). */
const TITLE_MAX_LENGTH = 255;

/** The data key (with type `group`) that tells the app a push is an invite. */
const INVITE_KIND = 'group_invite';

const INVITE_GONE = 'This invitation is no longer available. The group may have been deleted.';
const INVITE_EXPIRED = 'This invitation has expired. Ask for a new one, or join with the group\'s code.';
const INVITE_ACCEPTED = 'You already accepted this invitation.';
const INVITE_DECLINED = 'You declined this invitation. Ask for a new one, or join with the group\'s code.';

/** Truncates by code point so a surrogate pair is never split in half. */
const truncate = (text, max) => {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
};

/** A coordinate from the accept body, or null when absent or unusable. */
const readCoordinate = (value, limit) => {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  else return null;
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
};

/** The row as the app receives it. */
const toInvite = (row) => ({
  id: row.id,
  group_id: row.group_id,
  group_name: row.group_name,
  inviter_name: row.inviter_name,
  created_at: row.created_at,
  expires_at: row.expires_at,
});

/**
 * @param {object} deps
 * @param {(text: string, params?: any[]) => Promise<{rows: any[], rowCount: number}>} deps.query
 * @param {() => Promise<{query: Function, release: Function}>} deps.getClient a pooled client, for the accept transaction
 * @param {(userIds: string[], payload: object) => Promise<number>} [deps.notify]
 *   notificationService.notify; by default built on [deps.query]
 */
const buildGroupInviteHandlers = ({
  query,
  getClient,
  notify = buildNotificationService({ query, getMessaging: firebase.getMessaging }).notify,
}) => {
  /**
   * Creates or refreshes an invite for every account among [emails] that can
   * be invited into [group], and notifies each one.
   *
   * Left out: the inviter themself, addresses with no account, suspended
   * accounts, accounts that have not verified the address, an address that
   * more than one active account has (in any case), people already in the
   * group, anyone in a block with the inviter, and anyone an active member
   * blocked (they could not join).
   * Someone already invited gets the same invite again, refreshed, rather
   * than a second one.
   *
   * Never throws: the email invitation goes out whatever happens here.
   * Returns the number of people notified, or -1 when the invites could not
   * be written.
   */
  const createInvites = async ({ groupId, groupName, inviterId, inviterName, emails }) => {
    const addresses = [...new Set(
      (Array.isArray(emails) ? emails : []).map((address) => String(address).trim().toLowerCase())
    )].filter((address) => address !== '');
    if (addresses.length === 0) return 0;

    let invites;
    try {
      const result = await query(
        `INSERT INTO group_invites (group_id, inviter_id, invitee_id)
         SELECT $1, $2, u.id
           FROM users u
          WHERE LOWER(u.email) = ANY($3::text[])
            AND u.id <> $2
            AND u.status = 'active'
            AND u.email_verified = true
            AND NOT EXISTS (SELECT 1 FROM users other
                             WHERE LOWER(other.email) = LOWER(u.email)
                               AND other.id <> u.id
                               AND other.status = 'active')
            AND NOT EXISTS (SELECT 1 FROM group_members gm
                             WHERE gm.group_id = $1 AND gm.user_id = u.id AND gm.status = 'active')
            AND NOT EXISTS (SELECT 1 FROM group_members gm
                              JOIN user_blocks ub ON ub.blocker_id = gm.user_id
                             WHERE gm.group_id = $1 AND gm.status = 'active' AND ub.blocked_id = u.id)
            AND ${notBlockedBetween('$2', 'u.id')}
         ON CONFLICT (group_id, invitee_id) WHERE status = 'pending'
         DO UPDATE SET inviter_id = EXCLUDED.inviter_id, created_at = NOW()
         RETURNING id, invitee_id`,
        [groupId, inviterId, addresses]
      );
      invites = result.rows;
    } catch (err) {
      console.error(`Group invites could not be written (group ${groupId}):`, err.message);
      return -1;
    }

    const title = truncate(`${inviterName} invited you to join ${groupName}`, TITLE_MAX_LENGTH);
    const message = `${inviterName} invited you to join the group "${groupName}". ` +
      `Join or decline in CaribWayz. The invitation lasts ${INVITE_LIFETIME_DAYS} days.`;
    let notified = 0;
    // One at a time: each push carries its own invite id.
    for (const invite of invites) {
      const written = await notify([invite.invitee_id], {
        type: 'group',
        category: 'group',
        title,
        message,
        reference_id: groupId,
        data: { kind: INVITE_KIND, invite_id: invite.id },
      });
      if (written > 0) notified += 1;
      else if (written < 0) console.error(`Group invite notification failed (group ${groupId}, invite ${invite.id})`);
    }
    return notified;
  };

  /** GET /groups/invites: the caller's invites still to answer, newest first. */
  const listInvites = async (req, res) => {
    try {
      // Invites from someone now in a block with the caller are left off:
      // neither should see the other's name.
      const result = await query(
        `SELECT gi.id, gi.group_id, g.group_name, u.name AS inviter_name, gi.created_at,
                gi.created_at + make_interval(days => $2::int) AS expires_at
           FROM group_invites gi
           JOIN groups g ON g.id = gi.group_id
           JOIN users u ON u.id = gi.inviter_id
          WHERE gi.invitee_id = $1
            AND gi.status = 'pending'
            AND gi.created_at > NOW() - make_interval(days => $2::int)
            AND ${notBlockedBetween('$1', 'gi.inviter_id')}
          ORDER BY gi.created_at DESC`,
        [req.user.id, INVITE_LIFETIME_DAYS]
      );
      return success(res, { invites: result.rows.map(toInvite) });
    } catch (err) {
      console.error(`List group invites error (user ${req.user && req.user.id}):`, err);
      return error(res, 'Failed to load your group invitations', 500);
    }
  };

  /**
   * POST /groups/invites/:inviteId/accept, body optionally
   * { current_latitude, current_longitude } as joining by code takes.
   *
   * Runs in one transaction with the invite row locked, so two accepts of
   * the same invite (a tap on the push and on the list) cannot both add the
   * person: the second sees it accepted.
   */
  const acceptInvite = async (req, res) => {
    const { inviteId } = req.params;
    if (!UUID_PATTERN.test(String(inviteId))) return error(res, 'Invite id must be a valid UUID', 400);
    const body = req.body || {};
    const latitude = readCoordinate(body.current_latitude, 90);
    const longitude = readCoordinate(body.current_longitude, 180);
    const hasPosition = latitude !== null && longitude !== null;

    let client;
    try {
      client = await getClient();
    } catch (err) {
      console.error(`Accept group invite error (invite ${inviteId}): no database connection:`, err.message);
      return error(res, 'Failed to join group', 500);
    }

    const run = (text, params) => client.query(text, params);
    const finish = async (respond) => {
      await run('COMMIT');
      return respond();
    };

    try {
      await run('BEGIN');
      const found = await run(
        `SELECT gi.id, gi.group_id, gi.status,
                gi.created_at <= NOW() - make_interval(days => $3::int) AS past_lifetime
           FROM group_invites gi
          WHERE gi.id = $1 AND gi.invitee_id = $2
          FOR UPDATE`,
        [inviteId, req.user.id, INVITE_LIFETIME_DAYS]
      );
      const invite = found.rows[0];
      if (!invite) return await finish(() => notFound(res, INVITE_GONE));
      if (invite.status === 'accepted') return await finish(() => error(res, INVITE_ACCEPTED, 409));
      if (invite.status === 'declined') return await finish(() => error(res, INVITE_DECLINED, 409));
      if (invite.status === 'expired') return await finish(() => error(res, INVITE_EXPIRED, 410));

      const close = (status) => run(
        'UPDATE group_invites SET status = $2, responded_at = NOW() WHERE id = $1',
        [invite.id, status]
      );

      if (invite.past_lifetime) {
        await close('expired');
        return await finish(() => error(res, INVITE_EXPIRED, 410));
      }

      const outcome = await addMember(run, {
        groupId: invite.group_id,
        userId: req.user.id,
        latitude: hasPosition ? latitude : null,
        longitude: hasPosition ? longitude : null,
      });

      if (outcome === BLOCKED) {
        // It can never be used, so it leaves the list. The answer is the one
        // the join code gives, which does not say who blocked them.
        await close('expired');
        return await finish(() => forbidden(res, BLOCKED_MESSAGE));
      }
      if (outcome !== JOINED) {
        // Already in the group (joined some other way): the invite is spent.
        await close('accepted');
        return await finish(() => error(res, ALREADY_MEMBER_MESSAGE, 409));
      }

      const group = await run('SELECT * FROM groups WHERE id = $1', [invite.group_id]);
      return await finish(() => success(
        res,
        { group: group.rows[0], invite: { id: invite.id, status: 'accepted' } },
        'Joined group successfully'
      ));
    } catch (err) {
      try {
        await run('ROLLBACK');
      } catch (rollbackErr) {
        console.error(`Accept group invite rollback failed (invite ${inviteId}):`, rollbackErr.message);
      }
      console.error(`Accept group invite error (invite ${inviteId}, user ${req.user && req.user.id}):`, err);
      return error(res, 'Failed to join group', 500);
    } finally {
      client.release();
    }
  };

  /**
   * POST /groups/invites/:inviteId/decline. Declining twice, or declining one
   * that expired, is answered as done: either way it is off the list.
   */
  const declineInvite = async (req, res) => {
    const { inviteId } = req.params;
    if (!UUID_PATTERN.test(String(inviteId))) return error(res, 'Invite id must be a valid UUID', 400);
    try {
      const declined = await query(
        `UPDATE group_invites SET status = 'declined', responded_at = NOW()
          WHERE id = $1 AND invitee_id = $2 AND status = 'pending'
          RETURNING id`,
        [inviteId, req.user.id]
      );
      if (declined.rowCount > 0) {
        return success(res, { invite: { id: inviteId, status: 'declined' } }, 'Invitation declined');
      }

      const found = await query(
        'SELECT status FROM group_invites WHERE id = $1 AND invitee_id = $2',
        [inviteId, req.user.id]
      );
      const invite = found.rows[0];
      if (!invite) return notFound(res, INVITE_GONE);
      if (invite.status === 'accepted') return error(res, INVITE_ACCEPTED, 409);
      return success(res, { invite: { id: inviteId, status: invite.status } }, 'Invitation declined');
    } catch (err) {
      console.error(`Decline group invite error (invite ${inviteId}, user ${req.user && req.user.id}):`, err);
      return error(res, 'Failed to decline the invitation', 500);
    }
  };

  return { createInvites, listInvites, acceptInvite, declineInvite };
};

const { createInvites, listInvites, acceptInvite, declineInvite } = buildGroupInviteHandlers({
  query: db.query,
  getClient: db.getClient,
});

module.exports = {
  buildGroupInviteHandlers,
  createInvites,
  listInvites,
  acceptInvite,
  declineInvite,
  INVITE_LIFETIME_DAYS,
  INVITE_KIND,
  INVITE_GONE,
  INVITE_EXPIRED,
  INVITE_ACCEPTED,
  INVITE_DECLINED,
};
