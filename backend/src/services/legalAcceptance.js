const net = require('net');
const { TERMS_VERSION, PRIVACY_VERSION } = require('../config/legalVersions');

/**
 * Acceptance of the Terms of Service and the Privacy Policy (table
 * legal_acceptances, migration 032).
 *
 * A new account accepts both documents when it is made: /auth/register, and
 * the first Google, Facebook or phone sign-in. The acceptance is written in
 * the same transaction as the account, so there is never an account made by
 * the current app without its evidence. A person whose acceptance is missing
 * or out of date (an account from before this table, or a new version of a
 * document) accepts again in the app (POST /api/v1/user/legal-acceptance).
 *
 * Backward compatibility. App 1.0.11 and earlier send no acceptance fields,
 * and people have those builds installed. A sign-up that carries neither
 * field is therefore still accepted, as before, and nothing is recorded for
 * it: the account shows both documents as not accepted, and the current app
 * asks the person to accept on its next launch. A request that carries either
 * field comes from an app that shows the documents, so it must carry both,
 * equal to the current versions, or it is refused.
 */

/** The request body fields that carry the versions the person accepted. */
const FIELDS = Object.freeze({
  terms: 'accepted_terms_version',
  privacy: 'accepted_privacy_version',
});

/** How an acceptance was given, as stored in legal_acceptances.method. */
const METHODS = Object.freeze({
  emailSignUp: 'email_signup',
  google: 'google',
  facebook: 'facebook',
  phone: 'phone',
  reaccept: 'reaccept',
});

const CODES = Object.freeze({
  NOT_ACCEPTED: 'TERMS_NOT_ACCEPTED',
  OUTDATED: 'TERMS_VERSION_OUTDATED',
});

const MESSAGES = Object.freeze({
  [CODES.NOT_ACCEPTED]: 'Please read and accept the Terms of Service and Privacy Policy to continue.',
  [CODES.OUTDATED]: 'The Terms of Service or Privacy Policy have changed. Please update CaribWayz and accept the current versions.',
});

/** legal_acceptances.user_agent is VARCHAR(512). */
const USER_AGENT_MAX_LENGTH = 512;

/** The versions now in force (config/legalVersions.js). */
const currentVersions = () => ({ terms: TERMS_VERSION, privacy: PRIVACY_VERSION });

/**
 * What a request body says about acceptance:
 *   { status: 'absent' }        neither field: an app from before acceptance
 *   { status: 'accepted', versions }  both fields equal the current versions
 *   { status: 'refused', code }  any other combination
 * A field that is missing, null, blank or not text is not an acceptance
 * (TERMS_NOT_ACCEPTED); text that is not the current version is an outdated
 * one (TERMS_VERSION_OUTDATED).
 */
const readAcceptance = (body, versions = currentVersions()) => {
  const source = body && typeof body === 'object' ? body : {};
  const given = {
    terms: source[FIELDS.terms],
    privacy: source[FIELDS.privacy],
  };
  if (given.terms === undefined && given.privacy === undefined) return { status: 'absent' };

  const isText = (value) => typeof value === 'string' && value.trim() !== '';
  if (!isText(given.terms) || !isText(given.privacy)) {
    return { status: 'refused', code: CODES.NOT_ACCEPTED };
  }
  if (given.terms.trim() !== versions.terms || given.privacy.trim() !== versions.privacy) {
    return { status: 'refused', code: CODES.OUTDATED };
  }
  return { status: 'accepted', versions: { terms: versions.terms, privacy: versions.privacy } };
};

/**
 * Answers a refused acceptance: 400, with the code and the current versions
 * in data, the same envelope as the other coded refusals.
 */
const refuseAcceptance = (res, code, versions = currentVersions()) =>
  res.status(400).json({
    success: false,
    message: MESSAGES[code],
    data: { code, terms_version: versions.terms, privacy_version: versions.privacy },
  });

/**
 * The IP address and user agent of [req], kept as evidence of who accepted.
 * req.ip honours the proxy setting in server.js. Anything that is not an IP
 * address is stored as NULL rather than failing the sign-up.
 */
const evidenceFrom = (req) => {
  const ip = req && typeof req.ip === 'string' && net.isIP(req.ip) !== 0 ? req.ip : null;
  const header = req && req.headers ? req.headers['user-agent'] : undefined;
  const userAgent = typeof header === 'string' && header.trim() !== ''
    ? header.trim().slice(0, USER_AGENT_MAX_LENGTH)
    : null;
  return { ip, userAgent };
};

/**
 * Records that [userId] accepted [versions] of both documents. [run] is the
 * query function to use: a transaction client's, so the acceptance commits
 * or rolls back with the account. A version already recorded for the person
 * is kept as it is: the first acceptance is the evidence.
 */
const recordAcceptance = async (run, { userId, versions, method, ip = null, userAgent = null }) => {
  if (!Object.values(METHODS).includes(method)) throw new Error(`unknown acceptance method ${method}`);
  await run(
    `INSERT INTO legal_acceptances (user_id, document, version, method, ip_address, user_agent)
     VALUES ($1, 'terms', $2, $4, $5::inet, $6::text), ($1, 'privacy', $3, $4, $5::inet, $6::text)
     ON CONFLICT (user_id, document, version) DO NOTHING`,
    [userId, versions.terms, versions.privacy, method, ip, userAgent]
  );
};

/**
 * Whether [userId] has accepted the current version of each document, and
 * when. The shape the profile and the re-acceptance endpoint answer with.
 */
const acceptanceStatus = async (run, userId, versions = currentVersions()) => {
  const result = await run(
    `SELECT document, accepted_at FROM legal_acceptances
      WHERE user_id = $1
        AND ((document = 'terms' AND version = $2) OR (document = 'privacy' AND version = $3))`,
    [userId, versions.terms, versions.privacy]
  );
  const acceptedAt = { terms: null, privacy: null };
  for (const row of result.rows) acceptedAt[row.document] = row.accepted_at;
  return {
    terms_version: versions.terms,
    privacy_version: versions.privacy,
    terms_accepted: acceptedAt.terms !== null,
    privacy_accepted: acceptedAt.privacy !== null,
    terms_accepted_at: acceptedAt.terms,
    privacy_accepted_at: acceptedAt.privacy,
  };
};

module.exports = {
  FIELDS,
  METHODS,
  CODES,
  MESSAGES,
  USER_AGENT_MAX_LENGTH,
  currentVersions,
  readAcceptance,
  refuseAcceptance,
  evidenceFrom,
  recordAcceptance,
  acceptanceStatus,
};
