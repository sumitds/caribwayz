// Admin sign-in with two-step sign-in on (api migration 022). Run with:
// npm test (node --test).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { twoFactorChallengeFrom, isSixDigitCode, codeFailure, apiCode } from '../src/pages/auth/loginModel.js';

const CHALLENGE = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde';

/** The shape axios rejects with when the API answers [status] with [body]. */
const apiError = (status, body) => ({ response: { status, data: body } });

const required = (data = {}) => apiError(403, {
  success: false,
  message: 'Two-step sign-in is on for this account.',
  data: { code: 'TWO_FACTOR_REQUIRED', challenge: CHALLENGE, email_hint: 'a\u2022\u2022\u2022@example.com', expires_in_minutes: 10, ...data },
});

describe('twoFactorChallengeFrom', () => {
  test('reads the pending step from the 403 TWO_FACTOR_REQUIRED answer', () => {
    assert.deepEqual(twoFactorChallengeFrom(required()), {
      challenge: CHALLENGE, emailHint: 'a\u2022\u2022\u2022@example.com', expiresInMinutes: 10,
    });
  });

  test('falls back sensibly when the hint or expiry is missing', () => {
    const c = twoFactorChallengeFrom(required({ email_hint: '', expires_in_minutes: 'soon' }));
    assert.equal(c.emailHint, 'your email address');
    assert.equal(c.expiresInMinutes, 10);
  });

  test('is null for every other failure, so those still show as errors', () => {
    assert.equal(twoFactorChallengeFrom(apiError(401, { success: false, message: 'Invalid email or password' })), null);
    assert.equal(twoFactorChallengeFrom(apiError(403, { success: false, message: 'Your account has been suspended' })), null);
    assert.equal(twoFactorChallengeFrom(required({ challenge: 'short' })), null);
    assert.equal(twoFactorChallengeFrom(apiError(503, { data: { code: 'TWO_FACTOR_REQUIRED', challenge: CHALLENGE } })), null);
    assert.equal(twoFactorChallengeFrom(new Error('Network Error')), null);
    assert.equal(twoFactorChallengeFrom(undefined), null);
  });
});

describe('isSixDigitCode', () => {
  test('six digits only', () => {
    assert.equal(isSixDigitCode('012345'), true);
    assert.equal(isSixDigitCode(' 012345 '), true);
    for (const bad of ['12345', '1234567', '12a456', '', null, 123456]) assert.equal(isSixDigitCode(bad), false);
  });
});

describe('codeFailure', () => {
  test('a wrong code keeps the step and shows the attempts left', () => {
    const f = codeFailure(apiError(400, { message: 'Incorrect code. 3 attempts left.', data: { code: 'TWO_FACTOR_WRONG' } }));
    assert.deepEqual(f, { message: 'Incorrect code. 3 attempts left.', restart: false, locked: false });
  });

  test('an invalid or used-up code sends the admin back for a new one', () => {
    for (const code of ['TWO_FACTOR_INVALID', 'TWO_FACTOR_EXHAUSTED']) {
      assert.equal(codeFailure(apiError(400, { message: 'x', data: { code } })).restart, true, code);
    }
  });

  test('a lockout stops further tries', () => {
    const f = codeFailure(apiError(429, { message: 'Too many incorrect codes. Please try again tomorrow.', data: { code: 'TWO_FACTOR_LOCKED' } }));
    assert.equal(f.locked, true);
    assert.equal(f.restart, false);
  });

  test('no answer at all, or one without a message, still says something useful', () => {
    assert.equal(codeFailure(new Error('Network Error')).message, 'Could not reach CaribWayz. Check your connection and try again.');
    assert.equal(codeFailure(apiError(429, 'Too many requests')).message, 'Sign-in failed. Please try again.');
    assert.equal(apiCode(apiError(429, 'Too many requests')), null);
  });
});
