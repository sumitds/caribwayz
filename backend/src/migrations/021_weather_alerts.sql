-- Weather alerts: a push when a hurricane or tropical storm comes close to
-- where a person usually is.
--
-- The switch is on until the person turns it off, like the other safety pushes.
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS push_weather BOOLEAN DEFAULT TRUE;

-- The approximate area the app last reported for a person, rounded by the API
-- to one decimal place (about 11 km), so only a rough area is ever stored. It
-- is kept only while weather alerts are on: switching them off deletes it.
CREATE TABLE IF NOT EXISTS user_alert_areas (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per person per weather alert already sent, so the same storm is
-- never pushed twice to the same person. alert_key names the storm and its
-- strength (see weatherAlertService), so a storm that strengthens into a
-- hurricane is sent again once.
CREATE TABLE IF NOT EXISTS weather_alert_deliveries (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_key VARCHAR(200) NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, alert_key)
);

CREATE INDEX IF NOT EXISTS idx_weather_alert_deliveries_sent_at ON weather_alert_deliveries(sent_at);
