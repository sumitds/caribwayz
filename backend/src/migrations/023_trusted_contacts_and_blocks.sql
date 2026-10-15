-- More than one trusted contact, and blocking another person.
--
-- Idempotent: migrate.js runs every file on every boot.

-- Every phone number that is texted when the person sends an SOS, in the order
-- the texts open. users.emergency_contact stays, always equal to the first
-- entry (or NULL when there is none), because sign-up, the profile screen and
-- older app versions read and write that column.
ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contacts TEXT[] NOT NULL DEFAULT '{}';

-- Only phone numbers go on the list, in the form the API stores them
-- (normalizeContactPhone in utils/phone.js): spaces, dashes, dots and
-- brackets removed, then 7 to 15 characters of digits with an optional
-- leading "+". Sign-up took any text as the contact: "NA" for a skipped
-- field, or a name such as "Mom", and neither can be texted.

-- An earlier version of the copy below took the sign-up text as it was. A
-- list holding anything not in stored form is rewritten: each entry
-- normalised, one that is not a phone number dropped, a repeat of an earlier
-- entry (the same digits) dropped, the order kept. Lists the API wrote are
-- always in stored form, so they are never touched.
UPDATE users u
   SET emergency_contacts = COALESCE((
         SELECT array_agg(kept.phone ORDER BY kept.n)
           FROM (
             SELECT DISTINCT ON (regexp_replace(cleaned.phone, '[^0-9]', '', 'g')) cleaned.phone, cleaned.n
               FROM (
                 SELECT regexp_replace(t.c, '[[:space:]().-]', '', 'g') AS phone, t.n
                   FROM unnest(u.emergency_contacts) WITH ORDINALITY AS t(c, n)
               ) AS cleaned
              WHERE cleaned.phone ~ '^\+?[0-9]+$'
                AND char_length(cleaned.phone) BETWEEN 7 AND 15
              ORDER BY regexp_replace(cleaned.phone, '[^0-9]', '', 'g'), cleaned.n
           ) AS kept
       ), '{}')
 WHERE EXISTS (
         SELECT 1 FROM unnest(u.emergency_contacts) AS e(c)
          WHERE NOT (e.c ~ '^\+?[0-9]+$' AND char_length(e.c) BETWEEN 7 AND 15)
       );

-- The contact everyone already has becomes the first entry, when it is a
-- phone number. Only rows whose list is still empty are touched, and clearing
-- every contact also clears emergency_contact, so a second run never brings a
-- removed number back. emergency_contact itself keeps what was typed, as
-- sign-up does for a contact that is not a number.
UPDATE users
   SET emergency_contacts = ARRAY[regexp_replace(emergency_contact, '[[:space:]().-]', '', 'g')]
 WHERE cardinality(emergency_contacts) = 0
   AND emergency_contact IS NOT NULL
   AND regexp_replace(emergency_contact, '[[:space:]().-]', '', 'g') ~ '^\+?[0-9]+$'
   AND char_length(regexp_replace(emergency_contact, '[[:space:]().-]', '', 'g')) BETWEEN 7 AND 15;

-- The API enforces the same cap (MAX_EMERGENCY_CONTACTS in utils/phone.js).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'users'::regclass
       AND conname = 'users_emergency_contacts_max'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_emergency_contacts_max
      CHECK (cardinality(emergency_contacts) <= 5);
  END IF;
END $$;

-- blocker_id blocked blocked_id. A block works both ways for what the two
-- people see of each other (live location, SOS, check-ins), and stops the
-- blocked person joining or being invited into a group with the blocker.
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

-- The primary key serves "whom did I block"; this serves "who blocked me".
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked_id ON user_blocks(blocked_id);
