/**
 * The versions of the Terms of Service and the Privacy Policy now in force.
 *
 * They must equal the "Version:" line of the documents the app ships
 * (mobile/assets/legal/terms-of-service.md and privacy-policy.md), because the
 * app sends the version the person read and the API records an acceptance
 * only of the current one (migration 032, services/legalAcceptance.js).
 *
 * Raising either one makes every account show it as not accepted, and the
 * app asks each person to accept the new text before they carry on.
 */
const TERMS_VERSION = '1.0';
const PRIVACY_VERSION = '1.0';

module.exports = { TERMS_VERSION, PRIVACY_VERSION };
