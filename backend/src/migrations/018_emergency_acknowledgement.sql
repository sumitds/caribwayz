-- The emergency desk: who took an alert, and who closed it.
--
-- An alert stays 'active' until it is resolved; "acknowledged" is an active
-- alert with acknowledged_at set. Keeping the status column unchanged means
-- every existing reader of status = 'active' still sees acknowledged alerts as
-- open, which they are. acknowledged_at, not acknowledged_by, is the flag: a
-- deleted operator account nulls acknowledged_by but the alert was still taken.
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS acknowledged_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS resolved_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_emergency_open_unacknowledged
  ON emergency_alerts(created_at)
  WHERE status = 'active' AND acknowledged_at IS NULL;
