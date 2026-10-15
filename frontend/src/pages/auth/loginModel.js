// Sign-in page logic, kept free of React so it runs under node --test.
//
// With two-step sign-in on (api migration 022), a right password answers
// 403 { data: { code: 'TWO_FACTOR_REQUIRED', challenge, email_hint,
// expires_in_minutes } } and the sign-in finishes at
// POST /auth/login/verify-code with { challenge, code }.

export const TWO_FACTOR_REQUIRED = 'TWO_FACTOR_REQUIRED';

/** Codes after which this code can never work; the password step starts again. */
const RESTART_CODES = new Set(['TWO_FACTOR_INVALID', 'TWO_FACTOR_EXHAUSTED']);

const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The data.code of an axios error's API answer, or null. */
export const apiCode = (error) => {
  const code = error?.response?.data?.data?.code;
  return typeof code === 'string' ? code : null;
};

/**
 * The pending second step from a failed /auth/login call, or null when the
 * failure is anything else (wrong password, network, ...).
 */
export const twoFactorChallengeFrom = (error) => {
  if (error?.response?.status !== 403 || apiCode(error) !== TWO_FACTOR_REQUIRED) return null;
  const data = error.response.data.data;
  if (typeof data.challenge !== 'string' || !CHALLENGE_PATTERN.test(data.challenge)) return null;
  const minutes = Number.isInteger(data.expires_in_minutes) && data.expires_in_minutes > 0 ? data.expires_in_minutes : 10;
  return {
    challenge: data.challenge,
    emailHint: typeof data.email_hint === 'string' && data.email_hint !== '' ? data.email_hint : 'your email address',
    expiresInMinutes: minutes,
  };
};

export const isSixDigitCode = (code) => typeof code === 'string' && /^[0-9]{6}$/.test(code.trim());

/**
 * What to show after a failed code: the message, whether a new code is
 * needed (back to the password step), and whether to stop for today.
 */
export const codeFailure = (error) => {
  const code = apiCode(error);
  const serverMessage = error?.response?.data?.message;
  let message;
  if (typeof serverMessage === 'string' && serverMessage.trim() !== '') message = serverMessage;
  else if (!error?.response) message = 'Could not reach CaribWayz. Check your connection and try again.';
  else message = 'Sign-in failed. Please try again.';
  return {
    message,
    restart: RESTART_CODES.has(code),
    locked: code === 'TWO_FACTOR_LOCKED',
  };
};
