-- Sign-in history with revocable sessions, and two-step sign-in by emailed
-- code for email+password accounts.
--
-- Idempotent: migrate.js runs every file on every boot.

-- One row per successful sign-in. The row's id is the session id carried in
-- the token (claim "sid"); a token is accepted only while its row exists and
-- has no revoked_at. Nothing derived from the caller's IP is kept, only how
-- they signed in and which kind of device the app said it was.
CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method VARCHAR(10) NOT NULL CHECK (method IN ('email', 'google', 'facebook', 'phone')),
  platform VARCHAR(10) NOT NULL CHECK (platform IN ('android', 'ios', 'web', 'unknown')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_created ON user_sessions(user_id, created_at DESC);

-- Two-step sign-in. Only a hash of the emailed code is kept, as for the
-- password reset code (migration 019), in columns of its own so neither code
-- can stand in for the other. The challenge hash ties the second step to the
-- sign-in whose password was checked; it is NULL for the code that confirms
-- turning two-step sign-in on.
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_code_hash VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_challenge_hash VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_purpose VARCHAR(10);
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_attempts INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'users'::regclass AND conname = 'users_two_factor_purpose_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_two_factor_purpose_check
      CHECK (two_factor_purpose IS NULL OR two_factor_purpose IN ('sign_in', 'enable'));
  END IF;
END $$;

-- Per-account limits that survive a new code being issued, as for the reset
-- code: codes sent in the current hour, and wrong guesses in the current day
-- across every code.
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_window_started_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_codes_issued INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_guesses_started_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_guesses INTEGER NOT NULL DEFAULT 0;

-- The second step finds the pending sign-in by its challenge.
CREATE INDEX IF NOT EXISTS idx_users_two_factor_challenge ON users(two_factor_challenge_hash)
  WHERE two_factor_challenge_hash IS NOT NULL;
