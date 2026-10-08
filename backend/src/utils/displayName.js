/**
 * Names a user can carry that are not names.
 *
 * Sign-up used to send "default" for every account because the form never
 * asked for one (migration 017 blanks those rows). A blank name means the same
 * thing: the person never told us.
 */
const PLACEHOLDER_NAMES = new Set(['default']);

const normalizeName = (name) =>
  typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';

/** True when [name] is empty or a known placeholder rather than a real name. */
const isPlaceholderName = (name) => {
  const normalized = normalizeName(name);
  return normalized === '' || PLACEHOLDER_NAMES.has(normalized.toLowerCase());
};

/**
 * The name to show other people for a user, or [fallback] when the account
 * carries none. Never returns "default", "undefined" or an empty string.
 */
const displayName = (name, fallback = 'A CaribWayz member') =>
  isPlaceholderName(name) ? fallback : normalizeName(name);

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes text for interpolation into HTML element content or a quoted attribute. */
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

module.exports = { PLACEHOLDER_NAMES, normalizeName, isPlaceholderName, displayName, escapeHtml };
