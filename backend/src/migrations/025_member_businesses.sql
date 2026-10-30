-- Member businesses: businesses that pay CaribWayz a yearly fee and are shown
-- on the map, with the fee tiers, the applications from the public
-- /membership page, and the payment instructions that page shows.
-- See docs/members-contract.md.
--
-- Idempotent: migrate.js runs every file on every boot.

-- Fee tiers by employee count. max_employees NULL is "or more"; annual_fee
-- NULL is a fee not set yet. An admin edits them; the seed below is the
-- client's examples only, so every seeded tier is provisional.
CREATE TABLE IF NOT EXISTS membership_tiers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  min_employees INT NOT NULL CHECK (min_employees >= 1),
  max_employees INT NULL,
  annual_fee NUMERIC(10,2) NULL CHECK (annual_fee IS NULL OR annual_fee >= 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  is_provisional BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (max_employees IS NULL OR max_employees >= min_employees)
);

-- Only into an empty table, so a tier an admin changed or removed is never
-- put back on the next boot.
INSERT INTO membership_tiers (name, min_employees, max_employees, annual_fee, currency, is_provisional, sort_order)
SELECT v.name, v.min_employees, v.max_employees, v.annual_fee, 'USD', TRUE, v.sort_order
  FROM (VALUES
    ('1-15 employees', 1, 15, 20.00::NUMERIC(10,2), 1),
    ('16-40 employees', 16, 40, 50.00::NUMERIC(10,2), 2),
    ('41-99 employees', 41, 99, NULL::NUMERIC(10,2), 3),
    ('100 or more employees', 100, NULL::INT, 100.00::NUMERIC(10,2), 4)
  ) AS v(name, min_employees, max_employees, annual_fee, sort_order)
 WHERE NOT EXISTS (SELECT 1 FROM membership_tiers);

-- adminController has written membership_tier and business_size since the
-- admin panel was built, but no migration ever added them, so adding a
-- business failed on the live database. They stay as free text; tier_id is
-- the tier a member pays for.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS membership_tier VARCHAR(50);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS business_size VARCHAR(20);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS tier_id INT REFERENCES membership_tiers(id) ON DELETE SET NULL;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS employee_count INT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255);
-- Existing rows become pending: none of them has paid, so none is shown on
-- the map until an admin makes it active.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS membership_status VARCHAR(20) NOT NULL DEFAULT 'pending';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS membership_expires_at TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS promo_text VARCHAR(280);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS promo_expires_at TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Activating an application copies its phone (VARCHAR(40), what the public
-- form allows) onto the business, which allowed only 30. Widening a varchar
-- never rewrites the table, and running this again changes nothing.
ALTER TABLE businesses ALTER COLUMN phone TYPE VARCHAR(40);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'businesses'::regclass
       AND conname = 'businesses_membership_status_check'
  ) THEN
    ALTER TABLE businesses ADD CONSTRAINT businesses_membership_status_check
      CHECK (membership_status IN ('pending', 'active', 'expired', 'cancelled'));
  END IF;
END $$;

-- What GET /members/nearby filters on before the distance is worked out.
CREATE INDEX IF NOT EXISTS idx_businesses_active_members
  ON businesses(latitude, longitude)
  WHERE is_active = TRUE AND membership_status = 'active';

-- One row per form sent from the public /membership page. tier_id and
-- quoted_fee are what the server chose from employee_count when it arrived,
-- so a later change to the tiers does not change what the business was told.
CREATE TABLE IF NOT EXISTS membership_applications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_name VARCHAR(200) NOT NULL,
  contact_name VARCHAR(200) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(40),
  address TEXT,
  category VARCHAR(100),
  employee_count INT NOT NULL CHECK (employee_count >= 1),
  latitude DOUBLE PRECISION CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION CHECK (longitude BETWEEN -180 AND 180),
  website TEXT,
  message TEXT,
  tier_id INT REFERENCES membership_tiers(id) ON DELETE SET NULL,
  quoted_fee NUMERIC(10,2) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'invoiced', 'paid', 'rejected')),
  business_id UUID NULL REFERENCES businesses(id) ON DELETE SET NULL,
  admin_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((latitude IS NULL) = (longitude IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_membership_applications_status ON membership_applications(status, created_at DESC);

-- Exactly one row: id can only be TRUE. payment_instructions stays empty
-- until the client's business bank account exists; the /membership page then
-- says the team will email an invoice.
CREATE TABLE IF NOT EXISTS membership_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  payment_instructions TEXT NOT NULL DEFAULT '',
  contact_email VARCHAR(255),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO membership_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;
