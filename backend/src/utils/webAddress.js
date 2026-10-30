/**
 * Whether [value] is a web address the app and admin site may turn into a
 * link: http or https only, to a host with a dot in it, without a user name
 * or password. "www.example.com" with no scheme is accepted and read as
 * https. Anything else (javascript:, intent:, data:, mailto:, file:, ...)
 * is refused, because the app and the admin panel open this value.
 *
 * An empty string is accepted here; callers decide whether the field is
 * required.
 */
const isWebAddress = (value) => {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length > 2000) return false;
  // Spaces and control characters have no place in an address and are how
  // a scheme gets smuggled past a naive check ("java\tscript:").
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return false;

  const acceptable = (url) => (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.hostname.includes('.') && !url.hostname.startsWith('.') && !url.hostname.endsWith('.') &&
    url.username === '' && url.password === '';

  if (/^https?:\/\//i.test(value)) {
    try {
      return acceptable(new URL(value));
    } catch (err) {
      return false;
    }
  }
  // No http(s) scheme: only a bare host and path, read as https. Any other
  // scheme lands in the host or the port here ("javascript:alert(1)" is not
  // a valid port; "intent://x" gives the host "intent", which has no dot).
  if (value.includes('://')) return false;
  try {
    return acceptable(new URL(`https://${value}`));
  } catch (err) {
    return false;
  }
};

module.exports = { isWebAddress };
