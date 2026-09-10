-- Responder access must be granted, never self-declared.
--
-- users.user_type is supplied by the caller at POST /api/v1/auth/register,
-- which is unauthenticated. Gating the emergency feed on it would let anyone
-- register as CaribOfficials and read the live coordinates, name and phone of
-- every person currently in an emergency, and close their alerts.
--
-- user_type stays as the account's self-declared kind, used for onboarding and
-- display. is_responder is the authorization principal and can only be set by
-- an admin through PATCH /api/v1/admin/users/:id/responder.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_responder BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS responder_approved_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS responder_approved_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Partial index: the feed authorization check only ever looks for approved
-- responders, and they are a small fraction of the table.
CREATE INDEX IF NOT EXISTS idx_users_is_responder
  ON users(is_responder) WHERE is_responder = TRUE;
