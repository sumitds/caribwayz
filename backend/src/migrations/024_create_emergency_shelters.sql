-- Disaster shelters and evacuation points for the Caribbean territories
-- CaribWayz serves, loaded from src/data/emergency_shelters.json at startup.
-- The Shelters map layer and the Emergency Shelters list read from here instead
-- of asking the public Overpass servers live, which are busiest exactly when a
-- storm is coming. Same shape and loading as roadside_places (016).
CREATE TABLE IF NOT EXISTS emergency_shelters (
  osm_key VARCHAR(40) PRIMARY KEY,           -- e.g. 'way/123456'
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  territory VARCHAR(2) NOT NULL,
  tags JSONB NOT NULL DEFAULT '{}'::jsonb,   -- name, phone, address and the shelter tags
  dataset_version VARCHAR(40) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_emergency_shelters_lat_lng ON emergency_shelters(latitude, longitude);
