-- Whether an account has proved it owns its email address.
--
-- /auth/register takes any address and never mails it, so an account's email
-- proves nothing until something shows the person reads that inbox. A group
-- invite inside the app goes only to a verified address
-- (groupInviteController.js createInvites): otherwise anyone could register a
-- stranger's address, receive the invite meant for them, join, and see where
-- the group is.
--
-- Set to true (authController.js):
--   * at a Google or Facebook sign-in whose token says the provider verified
--     the email (only such an address is ever stored for those accounts);
--   * when the person enters a password reset code or a two-step sign-in code
--     that was emailed to the address.
--
-- Idempotent: migrate.js runs every file on every boot.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;

-- Accounts made by Google or Facebook sign-in before this column existed.
-- Their address came from a token that said email_verified, the only case in
-- which the sign-in stores one (and Firebase sign-in, migration 019, is the
-- only way such an account has ever been made). Email accounts are left
-- false: nothing recorded shows that any of them read their inbox. A second
-- run finds nothing left to change.
UPDATE users u
   SET email_verified = true
 WHERE u.email_verified = false
   AND u.email IS NOT NULL
   AND u.auth_provider IN ('google', 'facebook')
   AND EXISTS (SELECT 1 FROM user_identities i
                WHERE i.user_id = u.id AND i.provider = u.auth_provider);

-- One account per address, whatever its case. users_email_key (001) only
-- refuses the exact same spelling, so "Ana@x.com" and "ana@x.com" could be two
-- accounts. Created only when no such pair exists already: a migration that
-- failed here would stop the whole file, so existing duplicates are reported
-- and left for a person to resolve, and the index is made on a later boot.
DO $$
DECLARE
  duplicated INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'users_email_lower_key') THEN
    RETURN;
  END IF;

  SELECT COUNT(*) INTO duplicated
    FROM (SELECT LOWER(email) FROM users
           WHERE email IS NOT NULL
           GROUP BY LOWER(email)
          HAVING COUNT(*) > 1) d;

  IF duplicated > 0 THEN
    RAISE NOTICE 'users_email_lower_key not created: % email address(es) are used by more than one account in different case', duplicated;
    RETURN;
  END IF;

  BEGIN
    CREATE UNIQUE INDEX users_email_lower_key ON users (LOWER(email)) WHERE email IS NOT NULL;
  EXCEPTION WHEN unique_violation THEN
    -- A case variant was registered between the count and the index.
    RAISE NOTICE 'users_email_lower_key not created: an email address in different case was added meanwhile';
  END;
END $$;
