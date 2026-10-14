-- Sign-in with Firebase (Google, Facebook, phone) and a password reset code
-- that is never stored or returned in the clear.
--
-- Idempotent: migrate.js runs every file on every boot.

-- A phone account has no email address. UNIQUE still holds for the rows that
-- have one; Postgres allows any number of NULLs under a unique constraint.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

-- Widen the provider check to 'phone'. Replaced only while it still lacks it,
-- so a reboot does not rewrite the constraint (and rescan the table) each time.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'users'::regclass
       AND conname = 'users_auth_provider_check'
       AND pg_get_constraintdef(oid) LIKE '%phone%'
  ) THEN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_auth_provider_check;
    ALTER TABLE users ADD CONSTRAINT users_auth_provider_check
      CHECK (auth_provider IN ('email', 'google', 'facebook', 'phone'));
  END IF;
END $$;

-- Which Firebase user signs in as which CaribWayz account. Looked up by
-- firebase_uid on every social or phone sign-in. One identity per provider per
-- account: a second Google account cannot attach itself to an account that
-- already has one.
CREATE TABLE IF NOT EXISTS user_identities (
  firebase_uid VARCHAR(128) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL CHECK (provider IN ('google', 'facebook', 'phone')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, provider)
);

-- Password reset: only a hash of the emailed code is kept, with a count of
-- wrong guesses. After five the code is void.
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code_hash VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_attempts INTEGER NOT NULL DEFAULT 0;

-- The old flow stored the code in plain text in otp_code (and returned it to
-- whoever asked). Any code still outstanding is void. Nothing writes otp_code
-- any more, so a second run matches nothing.
UPDATE users
   SET otp_code = NULL, otp_expires_at = NULL
 WHERE otp_code IS NOT NULL OR otp_expires_at IS NOT NULL;

-- Per-account limits that survive a new code being issued (reset_attempts is
-- per code, and starts again at 0 with each one). How many codes were sent in
-- the current hour, which also caps reset emails to one inbox; and how many
-- guesses were made in the current day, across every code.
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_window_started_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_codes_issued INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_guesses_started_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_guesses INTEGER NOT NULL DEFAULT 0;
