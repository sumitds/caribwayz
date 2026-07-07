CREATE TABLE IF NOT EXISTS sponsorships (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  business_name VARCHAR(200) NOT NULL,
  business_address TEXT,
  amount NUMERIC(10,2) NOT NULL DEFAULT 50.00,
  payment_method VARCHAR(20) DEFAULT 'card',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  starts_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
