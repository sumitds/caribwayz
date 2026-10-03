-- Roadside-help places (repair, towing, tyres, locksmiths, parts, fuel) for the
-- Caribbean territories CaribWayz serves, loaded from src/data/roadside_places.json
-- at startup. The Services lists read from here instead of asking the public
-- Overpass servers live, which are regularly busy or down.
CREATE TABLE IF NOT EXISTS roadside_places (
  osm_key VARCHAR(40) PRIMARY KEY,           -- e.g. 'node/123456'
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  territory VARCHAR(2) NOT NULL,
  kinds TEXT[] NOT NULL,                     -- e.g. {car_repair,tyres}
  tags JSONB NOT NULL DEFAULT '{}'::jsonb,   -- name, phone, address and the type tags
  dataset_version VARCHAR(40) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_roadside_places_lat_lng ON roadside_places(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_roadside_places_kinds ON roadside_places USING GIN (kinds);
