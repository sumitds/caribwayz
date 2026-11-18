-- Emergency Desk statuses kept apart: Pending, Acknowledged, Addressed,
-- Cancelled (Emergency Desk Disclaimer, section 5; services/emergencyStatus.js).
--
-- Until now an alert was 'active' or 'resolved', and "acknowledged" was an
-- active alert with acknowledged_at set. 'resolved' covered both the sender
-- cancelling their own alert and a desk operator closing it, so the record
-- could not tell them apart and the app called both "resolved". Each status
-- now has its own value in desk_status, and its own time and actor:
--   acknowledged  acknowledged_at, acknowledged_by   (migration 018)
--   addressed     addressed_at, addressed_by         (new)
--   cancelled     cancelled_at, cancelled_by         (new)
--   resolved      resolved_at, resolved_by           (migration 006/018; legacy only)
--
-- status stays, as the open/closed flag: 'active' while desk_status is
-- pending or acknowledged, 'resolved' once it is anything else. Every existing
-- reader (the admin dashboard count, the location updates, the app 1.0.11)
-- keeps working unchanged, and a constraint keeps the two columns in step.
--
-- Existing rows are mapped from what was recorded, never from a guess:
--   active, acknowledged_at set     -> acknowledged
--   active, acknowledged_at null    -> pending
--   resolved by the sender          -> cancelled. The sender's only way to close
--                                      an alert was "I'm safe - cancel the alert",
--                                      and their trusted contacts were told they
--                                      had cancelled it. resolved_at/by move to
--                                      cancelled_at/by unchanged.
--   resolved by anyone else, or by  -> resolved, as recorded. It is not turned
--   an account since deleted           into addressed: nobody marked those
--                                      alerts "addressed", and the desk's own
--                                      word at the time is the record.
--
-- An open alert (status 'active', or NULL) that also carries resolved_at or
-- resolved_by contradicts itself: the old API only ever wrote those together
-- with status = 'resolved', so such a row was reopened by hand. Every reader
-- treated it as open, so it stays open; the stray resolved_at/resolved_by are
-- copied, unchanged, to emergency_alerts_033_set_aside and cleared on the
-- alert, so nothing recorded is lost and the alert does not claim a close
-- that its status denies.
--
-- The API released before this migration (959524b, and any instance still
-- serving during a deploy or after a rollback) writes status, resolved_* and
-- acknowledged_* without desk_status. The trigger at the end of this file
-- derives desk_status for those writes, by the same mapping as the backfill
-- above, so they succeed and leave the alert in the right status:
--   status 'active' -> 'resolved', by the sender   -> cancelled (resolved_at/by
--                                                      move to cancelled_at/by)
--   status 'active' -> 'resolved', by anyone else  -> resolved
--   acknowledged_at set on a pending alert         -> acknowledged
--   acknowledged_at cleared on an acknowledged one -> pending
-- A write that changes desk_status itself (this release's API: every one of
-- its status writes moves desk_status) is left alone, and the constraints
-- below still refuse it if it disagrees with itself. A write that sets
-- desk_status to the value it already has cannot be told apart from one that
-- does not name it, and is treated as the old API's.
--
-- If a CHECK constraint still cannot be added because of rows this file did
-- not foresee, the migration does not fail (migrate.js would boot with no
-- desk_status column at all, and every emergency endpoint would fail). It
-- adds every constraint the data allows, raises a WARNING naming the one it
-- skipped (migrate.js logs it), and tries again on the next boot.
--
-- Idempotent: migrate.js runs every file on every boot. The backfill only
-- touches rows with no desk_status yet, and the constraints and the trigger
-- are added once.

ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS desk_status VARCHAR(20);
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS addressed_at TIMESTAMPTZ;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS addressed_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Open alerts that also say they were resolved: the record of that close is
-- kept here, as it was, before the alert is mapped as the open alert every
-- reader showed it as.
CREATE TABLE IF NOT EXISTS emergency_alerts_033_set_aside (
  alert_id UUID PRIMARY KEY REFERENCES emergency_alerts(id) ON DELETE CASCADE,
  status VARCHAR(20),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  set_aside_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO emergency_alerts_033_set_aside (alert_id, status, resolved_at, resolved_by)
SELECT id, status, resolved_at, resolved_by
  FROM emergency_alerts
 WHERE desk_status IS NULL
   AND status IS DISTINCT FROM 'resolved'
   AND (resolved_at IS NOT NULL OR resolved_by IS NOT NULL)
ON CONFLICT (alert_id) DO NOTHING;

UPDATE emergency_alerts
   SET resolved_at = NULL,
       resolved_by = NULL
 WHERE desk_status IS NULL
   AND status IS DISTINCT FROM 'resolved'
   AND (resolved_at IS NOT NULL OR resolved_by IS NOT NULL);

UPDATE emergency_alerts
   SET desk_status = CASE WHEN acknowledged_at IS NULL THEN 'pending' ELSE 'acknowledged' END
 WHERE desk_status IS NULL
   AND status = 'active';

UPDATE emergency_alerts
   SET desk_status = 'cancelled',
       cancelled_at = resolved_at,
       cancelled_by = resolved_by,
       resolved_at = NULL,
       resolved_by = NULL
 WHERE desk_status IS NULL
   AND status = 'resolved'
   AND resolved_by IS NOT NULL
   AND resolved_by = user_id
   AND resolved_at IS NOT NULL;

UPDATE emergency_alerts
   SET desk_status = 'resolved'
 WHERE desk_status IS NULL
   AND status = 'resolved';

-- Rows from before migration 006's default (status NULL) are open alerts.
UPDATE emergency_alerts
   SET status = 'active',
       desk_status = CASE WHEN acknowledged_at IS NULL THEN 'pending' ELSE 'acknowledged' END
 WHERE desk_status IS NULL
   AND status IS NULL;

ALTER TABLE emergency_alerts ALTER COLUMN desk_status SET DEFAULT 'pending';
ALTER TABLE emergency_alerts ALTER COLUMN desk_status SET NOT NULL;

-- Each constraint is added in its own block: one the data does not allow is
-- skipped with a WARNING, and the others are still added.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'emergency_alerts_desk_status_valid'
                   AND conrelid = 'emergency_alerts'::regclass) THEN
    BEGIN
      ALTER TABLE emergency_alerts ADD CONSTRAINT emergency_alerts_desk_status_valid
        CHECK (desk_status IN ('pending', 'acknowledged', 'addressed', 'cancelled', 'resolved'));
    EXCEPTION WHEN check_violation THEN
      RAISE WARNING 'migration 033: emergency_alerts_desk_status_valid not added, existing rows violate it: %', SQLERRM;
    END;
  END IF;

  -- status is the open/closed flag derived from desk_status, never set alone.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'emergency_alerts_desk_status_matches_status'
                   AND conrelid = 'emergency_alerts'::regclass) THEN
    BEGIN
      ALTER TABLE emergency_alerts ADD CONSTRAINT emergency_alerts_desk_status_matches_status
        CHECK (status = CASE WHEN desk_status IN ('pending', 'acknowledged') THEN 'active' ELSE 'resolved' END);
    EXCEPTION WHEN check_violation THEN
      RAISE WARNING 'migration 033: emergency_alerts_desk_status_matches_status not added, existing rows violate it: %', SQLERRM;
    END;
  END IF;

  -- Each status carries its own time, and no status borrows another's: an
  -- alert is never "resolved" because it was addressed or cancelled.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'emergency_alerts_desk_status_times'
                   AND conrelid = 'emergency_alerts'::regclass) THEN
    BEGIN
      ALTER TABLE emergency_alerts ADD CONSTRAINT emergency_alerts_desk_status_times
        CHECK (
          (desk_status <> 'pending' OR acknowledged_at IS NULL)
          AND (desk_status <> 'acknowledged' OR acknowledged_at IS NOT NULL)
          AND ((desk_status = 'addressed') = (addressed_at IS NOT NULL))
          AND ((desk_status = 'cancelled') = (cancelled_at IS NOT NULL))
          AND (resolved_at IS NULL OR desk_status = 'resolved')
          AND (resolved_by IS NULL OR desk_status = 'resolved')
        );
    EXCEPTION WHEN check_violation THEN
      RAISE WARNING 'migration 033: emergency_alerts_desk_status_times not added, existing rows violate it: %', SQLERRM;
    END;
  END IF;
END
$$;

-- Writes from the API released before this migration (see the header). Only
-- an UPDATE that left desk_status as it was, on an alert that is still open,
-- is looked at; the old API's INSERT names no status and takes the defaults
-- (status 'active', desk_status 'pending'), which already agree.
CREATE OR REPLACE FUNCTION emergency_alerts_derive_desk_status() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.desk_status IS DISTINCT FROM OLD.desk_status
     OR OLD.desk_status NOT IN ('pending', 'acknowledged') THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'resolved' AND OLD.status IS DISTINCT FROM 'resolved' THEN
    IF NEW.resolved_by IS NOT NULL AND NEW.resolved_by = NEW.user_id AND NEW.resolved_at IS NOT NULL THEN
      NEW.desk_status := 'cancelled';
      NEW.cancelled_at := NEW.resolved_at;
      NEW.cancelled_by := NEW.resolved_by;
      NEW.resolved_at := NULL;
      NEW.resolved_by := NULL;
    ELSE
      NEW.desk_status := 'resolved';
    END IF;
  ELSIF OLD.desk_status = 'pending' AND NEW.acknowledged_at IS NOT NULL THEN
    NEW.desk_status := 'acknowledged';
  ELSIF OLD.desk_status = 'acknowledged' AND NEW.acknowledged_at IS NULL THEN
    NEW.desk_status := 'pending';
  END IF;
  RETURN NEW;
END
$fn$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgname = 'emergency_alerts_derive_desk_status'
                   AND tgrelid = 'emergency_alerts'::regclass) THEN
    -- EXECUTE PROCEDURE, not FUNCTION: the older spelling is accepted by
    -- every Postgres version the hosted database may run.
    CREATE TRIGGER emergency_alerts_derive_desk_status
      BEFORE UPDATE ON emergency_alerts
      FOR EACH ROW EXECUTE PROCEDURE emergency_alerts_derive_desk_status();
  END IF;
END
$$;
