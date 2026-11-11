-- The registration details of the client's Business Membership Policy
-- (2026-11-09, section 6), and the Suspended membership status (sections 11
-- and 12). See docs/members-contract.md.
--
-- Idempotent: migrate.js runs every file on every boot.

-- Section 6, on the application from the public /membership page. Existing
-- columns keep their meaning: business_name is the registered business name,
-- phone the business telephone, address the physical address, category the
-- business category, website the website or social media link, contact_name
-- and email the owner's or authorized representative's name and email.
ALTER TABLE membership_applications ADD COLUMN IF NOT EXISTS trading_name VARCHAR(200);
ALTER TABLE membership_applications ADD COLUMN IF NOT EXISTS description VARCHAR(1000);
ALTER TABLE membership_applications ADD COLUMN IF NOT EXISTS business_email VARCHAR(255);
ALTER TABLE membership_applications ADD COLUMN IF NOT EXISTS contact_position VARCHAR(100);
ALTER TABLE membership_applications ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(40);
-- When the applicant ticked acceptance of the Business Membership Policy and
-- the Terms. NULL only on applications sent before this migration.
ALTER TABLE membership_applications ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;

-- The same details on the member listing, so they survive after the
-- application. name stays what the app shows (the trading name when there is
-- one); registered_name is the legal name. None of these is sent to the app.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS registered_name VARCHAR(200);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS business_email VARCHAR(255);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS contact_name VARCHAR(200);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS contact_position VARCHAR(100);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(40);

-- Suspended: paused by an admin without being cancelled. Like every status
-- other than active, it is not shown on the map. The check from migration 025
-- is replaced only while it still lacks 'suspended', so a later boot changes
-- nothing.
DO $$
DECLARE
  current_check TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO current_check
    FROM pg_constraint
   WHERE conrelid = 'businesses'::regclass
     AND conname = 'businesses_membership_status_check';

  IF current_check IS NOT NULL AND position('suspended' IN current_check) > 0 THEN
    RETURN;
  END IF;

  IF current_check IS NOT NULL THEN
    ALTER TABLE businesses DROP CONSTRAINT businesses_membership_status_check;
  END IF;

  ALTER TABLE businesses ADD CONSTRAINT businesses_membership_status_check
    CHECK (membership_status IN ('pending', 'active', 'suspended', 'expired', 'cancelled'));
END $$;
