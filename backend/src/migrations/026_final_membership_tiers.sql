-- The client's final membership tiers (2026-11-09), replacing the four
-- provisional examples migration 025 seeded:
--   Micro      1-5 employees    USD 20 a year
--   Small      6-20 employees   USD 40 a year
--   Medium     21-50 employees  USD 75 a year
--   Corporate  51+ employees    USD 125 a year
--
-- Every migration runs on every boot, so this only acts while the table still
-- holds exactly the four untouched 025 seed rows. Once it has run, or once an
-- admin has changed any tier, it does nothing and the admin panel stays the
-- place to edit tiers.
--
-- The rows are updated in place (same ids), so businesses and applications
-- that point at a tier keep a valid tier_id. Their tier_id is then re-chosen
-- from employee_count under the new ranges, the same rule as
-- services/membership.js selectTier: an active tier whose inclusive range
-- holds the count, lowest sort_order first, then the lowest minimum, then id. An
-- application's quoted_fee is left alone: it is what the business was told.
DO $$
DECLARE
  untouched_seed BOOLEAN;
BEGIN
  SELECT COUNT(*) = 4
         AND COUNT(*) FILTER (WHERE
               is_provisional = TRUE AND is_active = TRUE AND currency = 'USD'
               AND (name, min_employees, COALESCE(max_employees, -1), COALESCE(annual_fee, -1), sort_order) IN (
                 ('1-15 employees', 1, 15, 20.00, 1),
                 ('16-40 employees', 16, 40, 50.00, 2),
                 ('41-99 employees', 41, 99, -1, 3),
                 ('100 or more employees', 100, -1, 100.00, 4)
               )) = 4
    INTO untouched_seed
    FROM membership_tiers;

  IF NOT untouched_seed THEN
    RETURN;
  END IF;

  UPDATE membership_tiers t
     SET name = v.name,
         min_employees = v.min_employees,
         max_employees = v.max_employees,
         annual_fee = v.annual_fee,
         is_provisional = FALSE,
         updated_at = NOW()
    FROM (VALUES
      (1, 'Micro', 1, 5, 20.00::NUMERIC(10,2)),
      (2, 'Small', 6, 20, 40.00::NUMERIC(10,2)),
      (3, 'Medium', 21, 50, 75.00::NUMERIC(10,2)),
      (4, 'Corporate', 51, NULL::INT, 125.00::NUMERIC(10,2))
    ) AS v(sort_order, name, min_employees, max_employees, annual_fee)
   WHERE t.sort_order = v.sort_order;

  UPDATE businesses b
     SET tier_id = (
           SELECT t.id FROM membership_tiers t
            WHERE t.is_active = TRUE
              AND b.employee_count >= t.min_employees
              AND (t.max_employees IS NULL OR b.employee_count <= t.max_employees)
            ORDER BY t.sort_order NULLS LAST, t.min_employees, t.id
            LIMIT 1)
   WHERE b.employee_count IS NOT NULL;

  UPDATE membership_applications a
     SET tier_id = (
           SELECT t.id FROM membership_tiers t
            WHERE t.is_active = TRUE
              AND a.employee_count >= t.min_employees
              AND (t.max_employees IS NULL OR a.employee_count <= t.max_employees)
            ORDER BY t.sort_order NULLS LAST, t.min_employees, t.id
            LIMIT 1)
   WHERE a.employee_count IS NOT NULL;
END $$;
