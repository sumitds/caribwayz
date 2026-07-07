CREATE TABLE IF NOT EXISTS partners (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  tier VARCHAR(50) NOT NULL,
  coverage VARCHAR(50) NOT NULL DEFAULT 'local',
  contact_name VARCHAR(150),
  contact_email VARCHAR(200),
  contact_phone VARCHAR(50),
  notes TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
