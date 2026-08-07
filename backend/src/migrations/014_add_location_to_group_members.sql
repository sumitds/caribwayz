ALTER TABLE group_members
  ADD COLUMN IF NOT EXISTS current_latitude  DECIMAL(10, 8),
  ADD COLUMN IF NOT EXISTS current_longitude DECIMAL(11, 8),
  ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ;
