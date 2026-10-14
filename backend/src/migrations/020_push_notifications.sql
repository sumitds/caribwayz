-- Push notifications: the phones a person is signed in on, and which kinds of
-- push they want.
--
-- A token identifies one app install, not one person, so it is UNIQUE: when
-- someone signs out and another account signs in on the same phone, the row is
-- moved to the new account rather than duplicated, and the previous account
-- stops receiving pushes on a phone it no longer uses.
CREATE TABLE IF NOT EXISTS device_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  platform VARCHAR(10) NOT NULL CHECK (platform IN ('android', 'ios')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_user_id ON device_tokens(user_id);

-- One switch per push category. Promotions are opt-in; everything else is on
-- until the person turns it off. Existing rows take the defaults.
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS push_emergency BOOLEAN DEFAULT TRUE;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS push_group BOOLEAN DEFAULT TRUE;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS push_reports BOOLEAN DEFAULT TRUE;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS push_app_updates BOOLEAN DEFAULT TRUE;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS push_promotions BOOLEAN DEFAULT FALSE;
