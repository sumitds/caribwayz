-- Version 1 membership add-ons (docs/members-contract.md, "Version 1 plan"):
--   1. Featured placement: a member listed first and marked "Featured" until
--      an end date.
--   2. Promotional and seasonal campaigns: an offer an admin enters for a
--      business, spoken and shown only between its start and end dates.
--   3. Renewal reminders: when an admin last emailed a business about its
--      membership ending, and who did.
--
-- Dates: featured_until, start_date and end_date are calendar days in
-- Jamaica (America/Jamaica, UTC-5 all year), both ends inclusive. "Today" is
-- (NOW() AT TIME ZONE 'America/Jamaica')::date wherever they are compared.
--
-- Idempotent: migrate.js runs every file on every boot.

-- 1. Featured placement. Featured only while is_featured is ticked, today is
-- on or before featured_until, and the business is a member the app shows.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS featured_until DATE;

-- A tick without an end date would be featured for ever.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'businesses'::regclass AND conname = 'businesses_featured_until_check'
  ) THEN
    ALTER TABLE businesses ADD CONSTRAINT businesses_featured_until_check
      CHECK (is_featured = FALSE OR featured_until IS NOT NULL);
  END IF;
END $$;

-- 3. Renewal reminders. Set when a Send reminder email went out.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS last_reminder_sent_at TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS last_reminder_sent_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- 2. Campaigns. ended_at is set when an admin ends one early; the dates are
-- kept as entered, as the record of what was sold.
CREATE TABLE IF NOT EXISTS member_campaigns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id UUID NOT NULL,
  kind VARCHAR(20) NOT NULL,
  offer_text VARCHAR(280) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  ended_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT member_campaigns_business_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  CONSTRAINT member_campaigns_kind_check CHECK (kind IN ('promotional', 'seasonal')),
  CONSTRAINT member_campaigns_offer_check CHECK (btrim(offer_text) <> ''),
  CONSTRAINT member_campaigns_dates_check CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_member_campaigns_business_dates ON member_campaigns(business_id, start_date, end_date);
