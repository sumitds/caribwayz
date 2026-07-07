CREATE TABLE IF NOT EXISTS pois (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  category VARCHAR(50) NOT NULL CHECK (category IN ('restaurant', 'gas', 'hotel', 'tourist', 'hospital', 'police', 'pharmacy', 'bank', 'other')),
  latitude DECIMAL(10, 8) NOT NULL,
  longitude DECIMAL(11, 8) NOT NULL,
  address TEXT,
  phone VARCHAR(30),
  website TEXT,
  rating DECIMAL(2, 1) DEFAULT 0,
  is_featured BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pois_category ON pois(category);
CREATE INDEX IF NOT EXISTS idx_pois_location ON pois(latitude, longitude);
