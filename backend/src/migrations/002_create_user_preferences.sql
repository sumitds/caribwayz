CREATE TABLE IF NOT EXISTS user_preferences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_police BOOLEAN DEFAULT TRUE,
  alert_construction BOOLEAN DEFAULT TRUE,
  alert_hazards BOOLEAN DEFAULT TRUE,
  alert_traffic BOOLEAN DEFAULT TRUE,
  alert_business BOOLEAN DEFAULT FALSE,
  alert_tourism BOOLEAN DEFAULT FALSE,
  priority_level VARCHAR(10) DEFAULT 'high' CHECK (priority_level IN ('critical', 'high', 'low')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);
