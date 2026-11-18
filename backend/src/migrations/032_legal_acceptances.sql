-- Evidence that a person accepted the Terms of Service and the Privacy Policy.
--
-- Jamaica's Electronic Transactions Act recognises a contract made in an app,
-- provided the person could read the terms before being bound and CaribWayz
-- can show that they agreed. One row is one person accepting one version of
-- one document: who (user_id), what (document, version), when (accepted_at),
-- and how (method: the sign-up or re-acceptance that recorded it, with the
-- IP address and user agent of that request when known).
--
-- The current versions live in api/src/config/legalVersions.js. A person has
-- accepted a document when a row exists for its current version; publishing
-- a new version therefore asks everyone again (POST /api/v1/user/legal-acceptance).
--
-- The first acceptance of a version is the evidence, so a version is recorded
-- once per person (legal_acceptances_user_document_version_key); accepting it
-- again changes nothing.
--
-- Rows go with the account (ON DELETE CASCADE), like every other table the
-- account owns (accountController.js deleteAccount).
--
-- Idempotent: migrate.js runs every file on every boot.

CREATE TABLE IF NOT EXISTS legal_acceptances (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document VARCHAR(16) NOT NULL CHECK (document IN ('terms', 'privacy')),
  version VARCHAR(32) NOT NULL CHECK (version <> ''),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  method VARCHAR(16) NOT NULL CHECK (method IN ('email_signup', 'google', 'facebook', 'phone', 'reaccept')),
  ip_address INET,
  user_agent VARCHAR(512),
  -- Also the index by user: user_id leads it, so every lookup of a person's
  -- acceptances (profile, export, admin) uses it.
  CONSTRAINT legal_acceptances_user_document_version_key UNIQUE (user_id, document, version)
);
