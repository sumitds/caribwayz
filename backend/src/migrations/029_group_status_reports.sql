-- Group status notifications: a member arrived, has stopped, is running late,
-- or left (controllers/groupEventController.js, POST /groups/:id/status).
--
-- One row per member, group and status, holding when that status was last
-- shared. The API claims the row before telling the group, and a claim inside
-- the repeat window finds nothing to update, so a phone whose GPS keeps
-- crossing a threshold tells the group once per window, not every time. The
-- claim is a single statement, so two API instances, or two requests racing,
-- cannot both pass it.
--
-- No coordinates are kept: the row says only that a status was shared.
--
-- 'left_group' is the API's own announcement that the member left the group
-- (POST /groups/:id/leave). It has its own row, so ending the drive ('left')
-- does not hide the leave that follows, while leaving, rejoining and leaving
-- again tells the group once per window.
--
-- Idempotent: migrate.js runs every file on every boot.

CREATE TABLE IF NOT EXISTS group_status_reports (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(16) NOT NULL CHECK (status IN ('arrived', 'stopped', 'delayed', 'left', 'left_group')),
  reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id, status)
);

-- A table made before 'left_group' existed has the narrower check. Replaced
-- only while it still lacks it, so a reboot does not rewrite the constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'group_status_reports'::regclass
       AND conname = 'group_status_reports_status_check'
       AND pg_get_constraintdef(oid) LIKE '%left_group%'
  ) THEN
    ALTER TABLE group_status_reports DROP CONSTRAINT IF EXISTS group_status_reports_status_check;
    ALTER TABLE group_status_reports ADD CONSTRAINT group_status_reports_status_check
      CHECK (status IN ('arrived', 'stopped', 'delayed', 'left', 'left_group'));
  END IF;
END $$;
