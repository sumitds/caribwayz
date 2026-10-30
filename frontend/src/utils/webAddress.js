// The same rule as the API (api/src/utils/webAddress.js), so the forms say
// at once what the server would refuse: http or https only, to a host with
// a dot in it, without a user name or password. "www.example.com" with no
// scheme is read as https. An empty string is accepted.

export const isWebAddress = (value) => {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length > 2000) return false;
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
  if (value.includes('://')) return false;
  try {
    return acceptable(new URL(`https://${value}`));
  } catch (err) {
    return false;
  }
};

export const WEB_ADDRESS_MESSAGE = 'Enter a web address such as www.example.com or https://example.com.';
