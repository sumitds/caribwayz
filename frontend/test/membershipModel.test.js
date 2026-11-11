// The public /membership page (api: GET /members/tiers, POST /members/apply).
// Run with: npm test (node --test).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_FORM, HONEYPOT_FIELD, FEE_TO_BE_CONFIRMED, INVOICE_BY_EMAIL, formatFee, tierRange, tierForCount, buildApplication,
  thankYou, fieldErrorsFrom, submitErrorMessage,
} from '../src/pages/Public/membershipModel.js';

// As GET /members/tiers answers with the seeded tiers.
const TIERS = [
  { id: 1, name: '1-15 employees', min_employees: 1, max_employees: 15, annual_fee: 20, currency: 'USD', is_provisional: true },
  { id: 2, name: '16-40 employees', min_employees: 16, max_employees: 40, annual_fee: 50, currency: 'USD', is_provisional: true },
  { id: 3, name: '41-99 employees', min_employees: 41, max_employees: 99, annual_fee: null, currency: 'USD', is_provisional: true },
  { id: 4, name: '100 or more employees', min_employees: 100, max_employees: null, annual_fee: 100, currency: 'USD', is_provisional: true },
];

const apiError = (status, body) => ({ response: { status, data: body } });

describe('tiers on the page', () => {
  test('fees read as an amount, and a fee not set as "Fee to be confirmed"', () => {
    assert.equal(formatFee(TIERS[0]), 'USD 20.00 a year');
    assert.equal(formatFee(TIERS[2]), FEE_TO_BE_CONFIRMED);
    assert.equal(formatFee({ annual_fee: 12.5, currency: 'JMD' }), 'JMD 12.50 a year');
    assert.equal(formatFee(null), FEE_TO_BE_CONFIRMED);
  });

  test('ranges, including the open-ended top tier', () => {
    assert.equal(tierRange(TIERS[0]), '1 to 15 employees');
    assert.equal(tierRange(TIERS[3]), '100 or more employees');
    assert.equal(tierRange({ min_employees: 1, max_employees: 1 }), '1 employee');
  });

  test('the hint under the employee field matches the bracket', () => {
    assert.equal(tierForCount(TIERS, '15').id, 1);
    assert.equal(tierForCount(TIERS, '16').id, 2);
    assert.equal(tierForCount(TIERS, '50').id, 3);
    assert.equal(tierForCount(TIERS, '100000').id, 4);
    for (const bad of ['', '0', '-3', '2.5', 'ten']) assert.equal(tierForCount(TIERS, bad), null, bad);
    assert.equal(tierForCount(undefined, '5'), null);
  });
});

/** A form filled the way the policy asks, with spaces a person might leave. */
const FILLED = Object.freeze({
  ...EMPTY_FORM,
  business_name: ' Island Grill Ltd ', category: 'restaurant', address: ' 1 King St, Kingston ', phone: '876-555-0100',
  contact_name: 'Asha Brown', contact_position: ' Owner ', contact_phone: '+1 (876) 555-0199', email: 'asha@grill.test',
  employee_count: '12', accept_terms: true,
});

describe('buildApplication', () => {
  test('sends trimmed required fields, acceptance as true, and only the optional ones filled in', () => {
    assert.deepEqual(buildApplication({ ...FILLED, trading_name: ' Island Grill ', message: '  ', description: '' }), {
      body: {
        business_name: 'Island Grill Ltd', trading_name: 'Island Grill', category: 'restaurant', address: '1 King St, Kingston',
        phone: '876-555-0100', contact_name: 'Asha Brown', contact_position: 'Owner', contact_phone: '+1 (876) 555-0199',
        email: 'asha@grill.test', employee_count: 12, accept_terms: true,
      },
    });
  });

  test('every required field of the policy is checked, with a message for each', () => {
    const { errors } = buildApplication({ ...EMPTY_FORM });
    assert.deepEqual(Object.keys(errors).sort(), [
      'accept_terms', 'address', 'business_name', 'category', 'contact_name', 'contact_phone', 'contact_position',
      'email', 'employee_count', 'phone',
    ]);
    for (const message of Object.values(errors)) assert.ok(message.endsWith('.'), message);
  });

  test('only spaces count as empty', () => {
    const { errors } = buildApplication({ ...FILLED, category: '   ', address: ' ', contact_position: '\t' });
    assert.deepEqual(Object.keys(errors).sort(), ['address', 'category', 'contact_position']);
  });

  test('acceptance must be the tick box, not a truthy look-alike', () => {
    for (const accept of [false, 'true', 'on', 1, undefined]) {
      assert.ok(buildApplication({ ...FILLED, accept_terms: accept }).errors.accept_terms, String(accept));
    }
  });

  test('employee count must be a whole number from 1 to 1000000', () => {
    for (const bad of ['0', '-1', '2.5', '1e3', 'twelve', '1000001', ' ']) {
      assert.ok(buildApplication({ ...FILLED, employee_count: bad }).errors.employee_count, bad);
    }
    assert.equal(buildApplication({ ...FILLED, employee_count: '1000000' }).body.employee_count, 1000000);
  });

  test('a bad email, phone, or text over its limit is refused', () => {
    assert.ok(buildApplication({ ...FILLED, email: 'asha@' }).errors.email);
    assert.ok(buildApplication({ ...FILLED, phone: 'call me' }).errors.phone);
    assert.ok(buildApplication({ ...FILLED, contact_phone: 'ring' }).errors.contact_phone);
    assert.ok(buildApplication({ ...FILLED, business_email: 'info@' }).errors.business_email);
    assert.ok(buildApplication({ ...FILLED, message: 'x'.repeat(2001) }).errors.message);
    assert.ok(buildApplication({ ...FILLED, description: 'x'.repeat(1001) }).errors.description);
    assert.ok(buildApplication({ ...FILLED, trading_name: 'x'.repeat(201) }).errors.trading_name);
    assert.ok(buildApplication({ ...FILLED, contact_position: 'x'.repeat(101) }).errors.contact_position);
    assert.ok(buildApplication({ ...FILLED, business_name: 'A' }).errors.business_name);
    assert.equal(buildApplication({ ...FILLED, message: 'x'.repeat(2000) }).body.message.length, 2000);
    assert.equal(buildApplication({ ...FILLED, business_email: ' info@grill.test ' }).body.business_email, 'info@grill.test');
  });

  test('names in any script are kept as typed', () => {
    const { body } = buildApplication({ ...FILLED, business_name: 'Café Ñandú', trading_name: 'Ñandú 🌴', contact_name: 'Zoë Ó Briain' });
    assert.deepEqual([body.business_name, body.trading_name, body.contact_name], ['Café Ñandú', 'Ñandú 🌴', 'Zoë Ó Briain']);
  });

  test('the map pin is sent as numbers, both or neither', () => {
    assert.equal('latitude' in buildApplication(FILLED).body, false, 'no pin: no location');
    const { body } = buildApplication({ ...FILLED, latitude: '18.0179', longitude: '-76.8099' });
    assert.deepEqual([body.latitude, body.longitude], [18.0179, -76.8099]);
    for (const [lat, lng] of [['18', ''], ['', '-76'], ['91', '-76'], ['18', '181'], ['x', '-76']]) {
      assert.ok(buildApplication({ ...FILLED, latitude: lat, longitude: lng }).errors.latitude, `${lat},${lng}`);
    }
  });
});

describe('website and the hidden field', () => {
  const filled = FILLED;

  test('a website must be http or https; a bare www address is fine', () => {
    for (const bad of ['javascript:alert(1)', 'intent://scan/#Intent;end', 'mailto:a@b.com', 'grill']) {
      assert.ok(buildApplication({ ...filled, website: bad }).errors.website, bad);
    }
    assert.equal(buildApplication({ ...filled, website: ' www.grill.example ' }).body.website, 'www.grill.example');
    assert.equal(buildApplication({ ...filled, website: 'https://grill.example/menu' }).body.website, 'https://grill.example/menu');
  });

  test('the hidden field is sent only when something filled it', () => {
    assert.equal(HONEYPOT_FIELD, 'cw_hp');
    assert.equal(EMPTY_FORM[HONEYPOT_FIELD], '');
    assert.equal(HONEYPOT_FIELD in buildApplication(filled).body, false);
    assert.equal(buildApplication({ ...filled, [HONEYPOT_FIELD]: 'bot' }).body[HONEYPOT_FIELD], 'bot');
  });
});

describe('the thank-you screen', () => {
  test('shows the fee and the payment instructions when the admin has set them', () => {
    assert.deepEqual(thankYou({
      application_id: 'a', payment_instructions: 'Bank: NCB\nAccount 123',
      tier: { name: '1-15 employees', annual_fee: 20, currency: 'USD', is_provisional: true },
    }), { tierName: '1-15 employees', fee: 'USD 20.00 a year', provisional: true, instructions: 'Bank: NCB\nAccount 123' });
  });

  test('without instructions the page says the invoice will be emailed', () => {
    const t = thankYou({ application_id: 'a', payment_instructions: '   ', tier: { name: '41-99 employees', annual_fee: null, currency: 'USD', is_provisional: true } });
    assert.equal(t.instructions, null);
    assert.equal(t.fee, FEE_TO_BE_CONFIRMED);
    assert.equal(INVOICE_BY_EMAIL, "We'll email you an invoice.");
  });

  test('no tier fitted: the fee is to be confirmed', () => {
    assert.deepEqual(thankYou({ application_id: 'a', payment_instructions: '', tier: null }),
      { tierName: null, fee: FEE_TO_BE_CONFIRMED, provisional: false, instructions: null });
  });
});

describe('submission failures', () => {
  test('the API field messages show next to their fields', () => {
    const err = apiError(400, { success: false, errors: [
      { path: 'email', msg: 'A valid email address is required' },
      { path: 'email', msg: 'second message ignored' },
      { path: 'employee_count', msg: 'Number of employees must be a whole number from 1 to 1000000' },
    ] });
    assert.deepEqual(fieldErrorsFrom(err), {
      email: 'A valid email address is required',
      employee_count: 'Number of employees must be a whole number from 1 to 1000000',
    });
    assert.equal(fieldErrorsFrom(apiError(500, {})), null);
    assert.equal(fieldErrorsFrom(apiError(400, { errors: [] })), null);
    assert.equal(fieldErrorsFrom(new Error('Network Error')), null);
  });

  test('one sentence for each kind of failure', () => {
    assert.equal(submitErrorMessage(apiError(429, { message: 'Too many applications from this connection.' })), 'Too many applications from this connection.');
    assert.match(submitErrorMessage(apiError(429, {})), /wait an hour/);
    assert.match(submitErrorMessage(apiError(400, {})), /Check the fields/);
    assert.match(submitErrorMessage(new Error('Network Error')), /could not reach CaribWayz/);
    assert.match(submitErrorMessage(apiError(500, {})), /not sent/);
  });
});
