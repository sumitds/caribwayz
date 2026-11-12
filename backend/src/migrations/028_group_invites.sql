-- Group invites inside the app.
--
-- An invite by email still sends the join code to every address. When an
-- address belongs to a CaribWayz account, that person also gets a row here,
-- a notification and a push with Join and Decline, so they can join without
-- typing the code (controllers/groupInviteController.js).
--
-- Idempotent: migrate.js runs every file on every boot.

-- inviter_id invited invitee_id into group_id. Deleting the group or either
-- account removes the invite with it, so a deleted group's invite simply no
-- longer exists. An invite lasts INVITE_LIFETIME_DAYS (7) from created_at;
-- one past that is answered as expired and marked so when the invitee acts
-- on it. Users are UUID here, as users.id is.
CREATE TABLE IF NOT EXISTS group_invites (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  inviter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(10) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  CHECK (inviter_id <> invitee_id)
);

-- One pending invite per person per group: inviting them again refreshes it
-- (new inviter, new created_at) instead of adding a second. Answered invites
-- stay as the record and do not count.
CREATE UNIQUE INDEX IF NOT EXISTS uq_group_invites_pending
  ON group_invites(group_id, invitee_id) WHERE status = 'pending';

-- "My pending invites", the list the app shows.
CREATE INDEX IF NOT EXISTS idx_group_invites_invitee_pending
  ON group_invites(invitee_id) WHERE status = 'pending';
