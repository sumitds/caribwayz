-- Sign-up used to send the literal name "default" for every account, because
-- the form never asked for one. Those rows carry no name, so they are blanked:
-- every client already treats a blank name as "no name" and falls back, while
-- "default" was shown to group members and on SOS alerts as if it were a name.
-- Idempotent: a second run matches nothing.
UPDATE users
   SET name = '', updated_at = NOW()
 WHERE lower(btrim(name)) = 'default';
