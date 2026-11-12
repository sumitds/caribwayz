-- Trusted contacts who use CaribWayz see the emergency in the app.
--
-- Idempotent: migrate.js runs every file on every boot.

-- The phone number Firebase confirmed by text message at the person's last
-- phone sign-in. users.phone is not that: sign-up and Edit Profile take any
-- number, so matching a trusted contact on it would let anyone type someone
-- else's number into their profile and receive the live location of every
-- person who trusts that number. Only this column is matched.
--
-- Not filled from users.phone for existing accounts, for the same reason: a
-- phone account may have edited users.phone since it signed up. It is written
-- on each phone sign-in from then on (authController, recordVerifiedPhone).
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_phone VARCHAR(20);

-- Trusted contacts are narrowed to candidates by digits here, then compared as
-- E.164 numbers (contactE164 in utils/phone.js, contactAlertService.js).
CREATE INDEX IF NOT EXISTS idx_users_verified_phone_digits
  ON users ((regexp_replace(verified_phone, '[^0-9]', '', 'g')))
  WHERE verified_phone IS NOT NULL;

-- Where the person is now, sent by their phone while the alert is open.
-- latitude and longitude stay where the alert was raised.
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS live_latitude DECIMAL(10, 8);
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS live_longitude DECIMAL(11, 8);
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS live_located_at TIMESTAMPTZ;

-- Who was told about an alert as the sender's trusted contact. Only these
-- accounts can open it, and only while it is active do they see where the
-- sender is.
CREATE TABLE IF NOT EXISTS emergency_alert_contacts (
  alert_id UUID NOT NULL REFERENCES emergency_alerts(id) ON DELETE CASCADE,
  contact_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (alert_id, contact_user_id)
);

-- The primary key serves "who was told about this alert"; this serves "which
-- alerts was I told about".
CREATE INDEX IF NOT EXISTS idx_emergency_alert_contacts_contact
  ON emergency_alert_contacts(contact_user_id);
