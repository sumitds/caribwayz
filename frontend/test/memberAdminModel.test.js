// Admin pages for member businesses, tiers and applications. Run with:
// npm test (node --test).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  toDateTimeLocal, fromDateTimeLocal, isShownOnMap, isPromoLive, EMPTY_BUSINESS_FORM, businessFormFrom, businessPayload,
  tierRangeShort, feeLabel, EMPTY_TIER_FORM, tierFormFrom, tierPayload, activationPayload, apiMessage,
} from '../src/pages/Admin/memberAdminModel.js';

const NOW = new Date('2026-10-30T12:00:00Z');
const LATER = '2026-12-01T00:00:00.000Z';
const EARLIER = '2026-10-01T00:00:00.000Z';

describe('dates in the forms', () => {
  test('a timestamp round-trips through the datetime-local field', () => {
    const local = toDateTimeLocal(LATER);
    assert.match(local, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    assert.equal(fromDateTimeLocal(local), LATER);
  });

  test('empty is null; unreadable is undefined', () => {
    assert.equal(toDateTimeLocal(null), '');
    assert.equal(toDateTimeLocal('nonsense'), '');
    assert.equal(fromDateTimeLocal(''), null);
    assert.equal(fromDateTimeLocal('nonsense'), undefined);
  });
});

describe('what the app shows', () => {
  const member = { is_active: true, membership_status: 'active', membership_expires_at: LATER };

  test('only a listed, active, unexpired member is on the map', () => {
    assert.equal(isShownOnMap(member, NOW), true);
    assert.equal(isShownOnMap({ ...member, membership_expires_at: null }, NOW), true);
    assert.equal(isShownOnMap({ ...member, membership_expires_at: EARLIER }, NOW), false);
    assert.equal(isShownOnMap({ ...member, membership_status: 'pending' }, NOW), false);
    assert.equal(isShownOnMap({ ...member, is_active: false }, NOW), false);
    assert.equal(isShownOnMap(null, NOW), false);
  });

  test('a promotion is live until it ends', () => {
    assert.equal(isPromoLive({ promo_text: '10% off', promo_expires_at: LATER }, NOW), true);
    assert.equal(isPromoLive({ promo_text: '10% off', promo_expires_at: null }, NOW), true);
    assert.equal(isPromoLive({ promo_text: '10% off', promo_expires_at: EARLIER }, NOW), false);
    assert.equal(isPromoLive({ promo_text: '  ', promo_expires_at: null }, NOW), false);
    assert.equal(isPromoLive({ promo_text: null }, NOW), false);
  });
});

describe('the business form', () => {
  const filled = { ...EMPTY_BUSINESS_FORM, name: ' Island Grill ', latitude: '18.0179', longitude: '-76.8099' };

  test('sends numbers, and empty optional fields as null so an edit clears them', () => {
    const { body } = businessPayload({ ...filled, promo_text: ' 10% off ', tier_id: '2', employee_count: '12' });
    assert.deepEqual(body, {
      name: 'Island Grill', latitude: 18.0179, longitude: -76.8099, employee_count: 12, tier_id: 2,
      membership_status: 'pending', membership_expires_at: null, promo_expires_at: null, is_active: true,
      category: null, address: null, phone: null, website: null, description: null, contact_email: null, promo_text: '10% off',
    });
  });

  test('the name and a valid location are required', () => {
    const { errors } = businessPayload({ ...EMPTY_BUSINESS_FORM });
    assert.deepEqual(Object.keys(errors).sort(), ['latitude', 'longitude', 'name']);
    assert.ok(businessPayload({ ...filled, latitude: '91' }).errors.latitude);
    assert.ok(businessPayload({ ...filled, longitude: '-180.5' }).errors.longitude);
  });

  test('a long promotion, bad email, bad count or date is refused', () => {
    assert.ok(businessPayload({ ...filled, promo_text: 'x'.repeat(281) }).errors.promo_text);
    assert.ok(businessPayload({ ...filled, contact_email: 'nope' }).errors.contact_email);
    assert.ok(businessPayload({ ...filled, employee_count: '2.5' }).errors.employee_count);
    assert.ok(businessPayload({ ...filled, promo_expires_at: 'nonsense' }).errors.promo_expires_at);
    assert.ok(businessPayload({ ...filled, membership_status: 'gold' }).errors.membership_status);
  });

  test('a website must be http or https, and a phone at most 40 characters', () => {
    assert.ok(businessPayload({ ...filled, website: 'javascript:alert(1)' }).errors.website);
    assert.ok(businessPayload({ ...filled, website: 'intent://scan/#Intent;end' }).errors.website);
    assert.equal(businessPayload({ ...filled, website: 'www.grill.example' }).body.website, 'www.grill.example');
    assert.equal(businessPayload({ ...filled, phone: '1'.repeat(40) }).body.phone, '1'.repeat(40));
    assert.ok(businessPayload({ ...filled, phone: '1'.repeat(41) }).errors.phone);
  });

  test('editing starts from the saved business', () => {
    const form = businessFormFrom({
      name: 'Island Grill', latitude: 18.0179, longitude: -76.8099, tier_id: 3, employee_count: 50,
      membership_status: 'active', membership_expires_at: LATER, promo_text: null, is_active: false,
    });
    assert.equal(form.latitude, '18.0179');
    assert.equal(form.tier_id, '3');
    assert.equal(form.employee_count, '50');
    assert.equal(form.promo_text, '');
    assert.equal(form.is_active, false);
    assert.equal(fromDateTimeLocal(form.membership_expires_at), LATER);
    assert.equal(businessPayload(form).body.membership_expires_at, LATER);
  });
});

describe('the tier form', () => {
  test('an empty maximum is open-ended and an empty fee is not set yet', () => {
    const { body } = tierPayload({ ...EMPTY_TIER_FORM, name: '100 or more', min_employees: '100' });
    assert.deepEqual(body, {
      name: '100 or more', min_employees: 100, max_employees: null, annual_fee: null, currency: 'USD',
      is_provisional: true, sort_order: null, is_active: true,
    });
  });

  test('the fee is rounded to cents and the currency upper-cased', () => {
    const { body } = tierPayload({ ...EMPTY_TIER_FORM, name: 'x', min_employees: '1', max_employees: '15', annual_fee: '20.005', currency: 'jmd', sort_order: '2' });
    assert.equal(body.annual_fee, 20.01);
    assert.equal(body.currency, 'JMD');
    assert.equal(body.max_employees, 15);
    assert.equal(body.sort_order, 2);
  });

  test('bad values are refused before the API', () => {
    assert.ok(tierPayload({ ...EMPTY_TIER_FORM, name: 'x', min_employees: '10', max_employees: '5' }).errors.max_employees);
    assert.ok(tierPayload({ ...EMPTY_TIER_FORM, name: 'x', min_employees: '0' }).errors.min_employees);
    assert.ok(tierPayload({ ...EMPTY_TIER_FORM, name: 'x', min_employees: '1', annual_fee: '-1' }).errors.annual_fee);
    assert.ok(tierPayload({ ...EMPTY_TIER_FORM, name: 'x', min_employees: '1', currency: 'US' }).errors.currency);
    assert.ok(tierPayload({ ...EMPTY_TIER_FORM, min_employees: '1' }).errors.name);
  });

  test('editing starts from the saved tier', () => {
    const form = tierFormFrom({ name: '41-99', min_employees: 41, max_employees: 99, annual_fee: null, currency: 'USD', is_provisional: true, sort_order: 3, is_active: true });
    assert.deepEqual([form.min_employees, form.max_employees, form.annual_fee, form.sort_order], ['41', '99', '', '3']);
  });

  test('labels', () => {
    assert.equal(tierRangeShort({ min_employees: 1, max_employees: 15 }), '1-15');
    assert.equal(tierRangeShort({ min_employees: 100, max_employees: null }), '100+');
    assert.equal(feeLabel(20, 'USD'), 'USD 20.00');
    assert.equal(feeLabel(null), 'Not set');
  });
});

describe('activating a paid application', () => {
  test('12 months by default; the location is optional but both or neither', () => {
    assert.deepEqual(activationPayload({ latitude: '', longitude: '', months: '' }), { body: { months: 12 } });
    assert.deepEqual(activationPayload({ latitude: '18.5', longitude: '-77', months: '6' }), { body: { latitude: 18.5, longitude: -77, months: 6 } });
    assert.ok(activationPayload({ latitude: '18.5', longitude: '', months: '12' }).errors.longitude);
    assert.ok(activationPayload({ latitude: '95', longitude: '-77', months: '12' }).errors.latitude);
    assert.ok(activationPayload({ latitude: '', longitude: '', months: '0' }).errors.months);
    assert.ok(activationPayload({ latitude: '', longitude: '', months: '121' }).errors.months);
  });
});

describe('apiMessage', () => {
  test('prefers the first field message, then the message, then the fallback', () => {
    assert.equal(apiMessage({ response: { data: { message: 'Validation failed', errors: [{ msg: 'Months must be from 1 to 120' }] } } }, 'x'), 'Months must be from 1 to 120');
    assert.equal(apiMessage({ response: { data: { message: 'That membership tier does not exist' } } }, 'x'), 'That membership tier does not exist');
    assert.equal(apiMessage(new Error('Network Error'), 'Failed'), 'Failed');
  });
});
