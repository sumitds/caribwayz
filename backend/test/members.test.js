// Member businesses (migration 025, docs/members-contract.md): the public
// /members endpoints the app and the /membership web page use, and the admin
// endpoints for tiers, applications, businesses and payment instructions.
//
// The unit tests use fakes and always run. The tests at the end run the real
// migrations, routes and SQL against Postgres, and only when TEST_DATABASE_URL
// points at a throwaway database (they create and delete rows).

const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const membership = require('../src/services/membership');
const { buildMembershipHandlers } = require('../src/controllers/membershipController');
const { buildMemberAdminHandlers } = require('../src/controllers/memberAdminController');
const { dropBotApplication, HONEYPOT_FIELD } = require('../src/controllers/membershipController');
const { isWebAddress } = require('../src/utils/webAddress');
const { clientNetworkKey } = require('../src/middleware/rateLimits');

const SESSION_ID = '0b9c8d7e-6f5a-4b3c-8d2e-1f0a9b8c7d6e';
const USER_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const ADMIN_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const APPLICATION_ID = '6f1c2b9e-3d4a-4c5b-8e7f-0a1b2c3d4e5f';
const BUSINESS_ID = '77777777-6666-4555-8444-333333333333';

const src = (mod) => require.resolve(path.join(__dirname, '../src', mod));

/** The seeded tiers as pg returns them (fees as strings). */
const SEEDED_TIERS = [
  { id: 1, name: '1-15 employees', min_employees: 1, max_employees: 15, annual_fee: '20.00', currency: 'USD', is_provisional: true, sort_order: 1, is_active: true },
  { id: 2, name: '16-40 employees', min_employees: 16, max_employees: 40, annual_fee: '50.00', currency: 'USD', is_provisional: true, sort_order: 2, is_active: true },
  { id: 3, name: '41-99 employees', min_employees: 41, max_employees: 99, annual_fee: null, currency: 'USD', is_provisional: true, sort_order: 3, is_active: true },
  { id: 4, name: '100 or more employees', min_employees: 100, max_employees: null, annual_fee: '100.00', currency: 'USD', is_provisional: true, sort_order: 4, is_active: true },
];

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

const silence = (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...a) => logged.push(a.map(String).join(' ')));
  t.mock.method(console, 'warn', (...a) => logged.push(a.map(String).join(' ')));
  return logged;
};

/** Lets the not-awaited application notice run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * routes/members.js and its rate limiter loaded fresh, so each app below
 * counts applications from zero.
 */
const freshMembersRouter = () => {
  for (const mod of ['middleware/rateLimits', 'routes/members']) delete require.cache[src(mod)];
  return require(src('routes/members'));
};

const listen = async (app) => {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
};

const close = (server) => new Promise((resolve) => server.close(resolve));

describe('choosing a tier from the employee count', () => {
  test('each seeded bracket, both ends inclusive', () => {
    for (const [count, id] of [[1, 1], [15, 1], [16, 2], [40, 2], [41, 3], [99, 3], [100, 4]]) {
      assert.equal(membership.selectTier(SEEDED_TIERS, count).id, id, `${count} employees`);
    }
  });

  test('100 or more has no upper bound', () => {
    assert.equal(membership.selectTier(SEEDED_TIERS, 1000000).id, 4);
  });

  test('a count no tier covers, a non-integer, or no tiers gives null', () => {
    const withGap = SEEDED_TIERS.filter((t) => t.id !== 3);
    assert.equal(membership.selectTier(withGap, 50), null);
    assert.equal(membership.selectTier(SEEDED_TIERS, 0), null);
    assert.equal(membership.selectTier(SEEDED_TIERS, 2.5), null);
    assert.equal(membership.selectTier([], 10), null);
    assert.equal(membership.selectTier(undefined, 10), null);
  });

  test('an inactive tier is never chosen', () => {
    const tiers = SEEDED_TIERS.map((t) => (t.id === 1 ? { ...t, is_active: false } : t));
    assert.equal(membership.selectTier(tiers, 5), null);
  });

  test('overlapping tiers: the first by sort_order wins', () => {
    const overlap = { id: 9, name: 'Promo', min_employees: 1, max_employees: 500, annual_fee: '5.00', currency: 'USD', is_provisional: false, sort_order: 0, is_active: true };
    assert.equal(membership.selectTier([...SEEDED_TIERS, overlap], 10).id, 9);
    assert.equal(membership.selectTier([...SEEDED_TIERS, { ...overlap, sort_order: null }], 10).id, 1);
  });

  test('a tier is shaped with numbers, and a fee not set yet is null', () => {
    assert.deepEqual(membership.publicTier(SEEDED_TIERS[0]), {
      id: 1, name: '1-15 employees', min_employees: 1, max_employees: 15, annual_fee: 20, currency: 'USD', is_provisional: true,
    });
    assert.equal(membership.publicTier(SEEDED_TIERS[2]).annual_fee, null);
    assert.equal(membership.publicTier(SEEDED_TIERS[3]).max_employees, null);
  });
});

describe('membership statuses and listing names', () => {
  test('suspended sits between active and expired, and is not shown on the map', () => {
    assert.deepEqual(membership.MEMBERSHIP_STATUSES, ['pending', 'active', 'suspended', 'expired', 'cancelled']);
    assert.match(membership.LISTED_MEMBER_SQL, /membership_status = 'active'/);
  });

  test('a listing is named by the trading name, else the registered name, trimmed', () => {
    assert.equal(membership.listingName({ business_name: 'Island Grill Ltd', trading_name: ' Island Grill ' }), 'Island Grill');
    for (const trading of [null, undefined, '', '   ', 42]) {
      assert.equal(membership.listingName({ business_name: ' Island Grill Ltd ', trading_name: trading }), 'Island Grill Ltd', String(trading));
    }
    assert.equal(membership.listingName({ business_name: 'Café Ñandú', trading_name: 'Ñandú 🌴' }), 'Ñandú 🌴');
    assert.equal(membership.listingName(null), '');
  });
});

describe('promotions and member shape', () => {
  const NOW = new Date('2026-10-30T12:00:00Z');

  test('a promotion past its expiry, empty or only spaces is null', () => {
    assert.equal(membership.currentPromo('10% off', '2026-10-30T11:59:59Z', NOW), null);
    assert.equal(membership.currentPromo('10% off', new Date('2026-10-30T12:00:00Z'), NOW), null, 'expiring this instant is over');
    assert.equal(membership.currentPromo('', null, NOW), null);
    assert.equal(membership.currentPromo('   ', null, NOW), null);
    assert.equal(membership.currentPromo(null, null, NOW), null);
    assert.equal(membership.currentPromo('10% off', 'not a date', NOW), null);
  });

  test('a promotion with a future expiry, or none, is shown', () => {
    assert.equal(membership.currentPromo('10% off', '2026-11-30T00:00:00Z', NOW), '10% off');
    assert.equal(membership.currentPromo(' Free coffee ', null, NOW), 'Free coffee');
  });

  test('coordinates are numbers and distance a whole number of metres', () => {
    const member = membership.publicMember({
      id: BUSINESS_ID, name: 'Island Grill', category: 'restaurant', latitude: '18.01790000', longitude: '-76.80990000',
      address: null, phone: '876 555 0100', website: null, description: null,
      promo_text: 'Free drink', promo_expires_at: '2026-10-01T00:00:00Z', distance_m: 123.6,
    }, NOW);
    assert.deepEqual(member, {
      id: BUSINESS_ID, name: 'Island Grill', category: 'restaurant', latitude: 18.0179, longitude: -76.8099,
      address: null, phone: '876 555 0100', website: null, description: null, promo_text: null, distance_m: 124,
    });
    assert.equal(typeof member.latitude, 'number');
  });

  test('the radius defaults to 2000 m and is clamped to 50..20000', () => {
    assert.equal(membership.clampRadius(undefined), 2000);
    assert.equal(membership.clampRadius(''), 2000);
    assert.equal(membership.clampRadius('1'), 50);
    assert.equal(membership.clampRadius('-500'), 50);
    assert.equal(membership.clampRadius('999999'), 20000);
    assert.equal(membership.clampRadius('750'), 750);
  });
});

describe('the nearby search box', () => {
  test('away from the antimeridian and the poles, one longitude range', () => {
    const box = membership.boundingBox(18, -76.8, 2000);
    assert.equal(box.lngRanges.length, 1);
    assert.ok(box.lngRanges[0][0] < -76.8 && box.lngRanges[0][1] > -76.8);
    assert.ok(Math.abs(box.latMax - box.latMin - (2 * 2000) / 111000) < 1e-9);
  });

  test('across the antimeridian the longitude range is split in two, inside -180..180', () => {
    for (const lng of [179.99, -179.99]) {
      const { lngRanges } = membership.boundingBox(17, lng, 20000);
      assert.equal(lngRanges.length, 2, String(lng));
      for (const [west, east] of lngRanges) {
        assert.ok(west >= -180 && east <= 180 && west <= east, JSON.stringify(lngRanges));
      }
      const covers = (x) => lngRanges.some(([w, e]) => x >= w && x <= e);
      assert.ok(covers(180) && covers(-180), 'both sides of the line');
      assert.ok(covers(lng));
    }
  });

  test('when the box reaches a pole every longitude is inside, and latitude stays in range', () => {
    for (const lat of [89.95, -89.95]) {
      const box = membership.boundingBox(lat, 120, 20000);
      assert.deepEqual(box.lngRanges, [[-180, 180]]);
      assert.ok(box.latMin >= -90 && box.latMax <= 90);
    }
    // Short of the pole the box is one wide range, still inside -180..180.
    const near = membership.boundingBox(89.8, 10, 20000).lngRanges;
    assert.equal(near.length, 1);
    assert.ok(near[0][0] >= -180 && near[0][1] <= 180 && near[0][1] - near[0][0] > 90, JSON.stringify(near));
  });
});

describe('website addresses', () => {
  test('http and https addresses, with or without the scheme, and empty are accepted', () => {
    for (const ok of ['', 'https://grill.example.com', 'http://grill.example.com/menu?x=1', 'www.grill.example',
      'grill.example.com/menu', 'HTTPS://GRILL.EXAMPLE.COM', 'grill.example.com:8080/menu']) {
      assert.equal(isWebAddress(ok), true, ok);
    }
  });

  test('other schemes and tricks are refused', () => {
    for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'javascript://example.com/%0Aalert(1)',
      'intent://scan/#Intent;scheme=zxing;end', 'intent:#Intent;end', 'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)', 'file:///etc/passwd', 'mailto:a@b.com', 'tel:+18765550100', 'sms:5550100',
      'ftp://files.example.com', 'https://user:pass@grill.example.com', 'java\tscript:alert(1)', ' https://grill.example.com',
      'https://localhost', 'grill', 'https://', 5, null, undefined, 'x'.repeat(2001)]) {
      assert.equal(isWebAddress(bad), false, JSON.stringify(bad));
    }
  });
});

describe('the apply limit key', () => {
  const key = (ip) => clientNetworkKey({ ip });

  test('IPv4 counts per address, also when written as IPv6', () => {
    assert.equal(key('203.0.113.7'), '203.0.113.7');
    assert.equal(key('::ffff:203.0.113.7'), '203.0.113.7');
  });

  test('IPv6 counts per /64, however the address is written', () => {
    const net = '2001:db8:abcd:12::/64';
    for (const ip of ['2001:db8:abcd:12::1', '2001:db8:abcd:12:ffff:ffff:ffff:ffff', '2001:0DB8:ABCD:0012:0:0:0:9',
      '2001:db8:abcd:12::192.0.2.1', '2001:db8:abcd:12::5%eth0']) {
      assert.equal(key(ip), net, ip);
    }
    assert.notEqual(key('2001:db8:abcd:13::1'), net);
    assert.equal(key('::1'), '0:0:0:0::/64');
  });
});

describe('the hidden form field', () => {
  test('filled: answered 201 in the usual shape, and nothing else runs', async (t) => {
    silence(t);
    let nextCalled = false;
    const res = makeRes();
    dropBotApplication({ body: { business_name: 'Spam', [HONEYPOT_FIELD]: 'http://spam.example' } }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(Object.keys(res.body.data).sort(), ['application_id', 'payment_instructions', 'tier']);
    assert.match(res.body.data.application_id, /^[0-9a-f-]{36}$/);
  });

  test('empty or missing: the application carries on', () => {
    for (const body of [{}, { [HONEYPOT_FIELD]: '' }, { [HONEYPOT_FIELD]: null }, undefined]) {
      let nextCalled = false;
      const res = makeRes();
      dropBotApplication({ body }, res, () => { nextCalled = true; });
      assert.equal(nextCalled, true, JSON.stringify(body));
      assert.equal(res.statusCode, null);
    }
  });
});

/** A form that passes every check of POST /members/apply. */
const GOOD_APPLICATION = Object.freeze({
  business_name: 'Island Grill Ltd', trading_name: 'Island Grill', category: 'restaurant',
  description: 'Jerk chicken and fish by the sea.', address: '1 King St, Kingston', phone: '876-555-0100',
  business_email: 'hello@grill.test', website: 'https://facebook.com/islandgrill',
  contact_name: 'Asha Brown', contact_position: 'Owner', contact_phone: '+1 (876) 555-0199', email: 'asha@grill.test',
  employee_count: 10, accept_terms: true,
});

describe('public member handlers', () => {
  const handlers = ({ rows = {}, fail = {}, calls = [], sendNotice, configured = true, adminEmail = 'ops@caribwayz.test' } = {}) =>
    buildMembershipHandlers({
      query: async (text, params) => {
        calls.push({ text, params });
        const key = /FROM membership_tiers/.test(text) ? 'tiers'
          : /FROM membership_settings/.test(text) ? 'settings'
            : /INSERT INTO membership_applications/.test(text) ? 'insert'
              : 'nearby';
        if (fail[key]) throw fail[key];
        if (key === 'insert') return { rows: [{ id: APPLICATION_ID, created_at: new Date() }] };
        return { rows: rows[key] || [] };
      },
      sendNotice: sendNotice || (async () => {}),
      isEmailConfigured: () => configured,
      adminContactEmail: () => adminEmail,
      now: () => new Date('2026-10-30T12:00:00Z'),
    });

  test('nearby: clamps the radius, asks for active members, and answers numbers', async () => {
    const calls = [];
    const res = makeRes();
    await handlers({
      calls,
      rows: {
        nearby: [{
          id: BUSINESS_ID, name: 'Island Grill', category: 'restaurant', latitude: '18.01800000', longitude: '-76.81000000',
          address: '1 King St', phone: null, website: null, description: null,
          promo_text: 'Free drink', promo_expires_at: '2026-11-01T00:00:00Z', distance_m: 15.2,
        }],
      },
    }).getNearby({ query: { lat: '18.0179', lng: '-76.8099', radius_m: '999999' } }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data.members, [{
      id: BUSINESS_ID, name: 'Island Grill', category: 'restaurant', latitude: 18.018, longitude: -76.81,
      address: '1 King St', phone: null, website: null, description: null, promo_text: 'Free drink', distance_m: 15,
    }]);
    const [{ text, params }] = calls;
    assert.match(text, /membership_status = 'active'/);
    assert.match(text, /membership_expires_at IS NULL OR b\.membership_expires_at > NOW\(\)/);
    assert.match(text, /is_active = TRUE/);
    assert.equal(params[8], 20000, 'radius clamped to 20 km');
    assert.equal(params[9], 50, 'at most 50');
    assert.ok(Math.abs((params[3] - params[2]) - (2 * 20000) / 111000) < 1e-9, 'the box matches the radius');
    assert.deepEqual([params[6], params[7]], [params[4], params[5]], 'one longitude range, sent twice');
  });

  test('nearby: the default radius is 2000 m', async () => {
    const calls = [];
    await handlers({ calls }).getNearby({ query: { lat: '18', lng: '-76.8' } }, makeRes());
    assert.equal(calls[0].params[8], 2000);
  });

  test('nearby: a database failure is a 500, logged', async (t) => {
    const logged = silence(t);
    const res = makeRes();
    await handlers({ fail: { nearby: new Error('db down') } }).getNearby({ query: { lat: '18', lng: '-76.8' } }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.success, false);
    assert.equal(logged.length, 1);
  });

  test('tiers: fees are numbers or null, in display order', async () => {
    const res = makeRes();
    await handlers({ rows: { tiers: SEEDED_TIERS } }).getTiers({}, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data.tiers.map((t) => t.annual_fee), [20, 50, null, 100]);
    assert.deepEqual(res.body.data.tiers.map((t) => t.max_employees), [15, 40, 99, null]);
    assert.deepEqual(Object.keys(res.body.data.tiers[0]).sort(),
      ['annual_fee', 'currency', 'id', 'is_provisional', 'max_employees', 'min_employees', 'name']);
  });

  test('tiers: a database failure is a 500, logged', async (t) => {
    silence(t);
    const res = makeRes();
    await handlers({ fail: { tiers: new Error('db down') } }).getTiers({}, res);
    assert.equal(res.statusCode, 500);
  });

  const form = (extra = {}) => ({
    business_name: 'Island Grill Ltd', trading_name: '  Island Grill ', category: 'restaurant',
    description: '', address: '  1 King St ', phone: '876-555-0100', business_email: '',
    contact_name: 'Asha Brown', contact_position: 'Owner', contact_phone: '876-555-0199', email: 'asha@grill.test',
    employee_count: 120, accept_terms: true, tier_id: 1, ...extra,
  });

  /** The INSERT's values by column name, read from its column list. */
  const insertedValues = (calls) => {
    const insert = calls.find((c) => /INSERT INTO membership_applications/.test(c.text));
    const columns = insert.text.match(/\(([^)]+)\)\s*VALUES/)[1].split(',').map((c) => c.trim());
    assert.equal(columns.length, insert.params.length, 'one value per column');
    return Object.fromEntries(columns.map((c, i) => [c, insert.params[i]]));
  };

  test('apply: the server picks the tier from employee_count and quotes its fee', async () => {
    const calls = [];
    const res = makeRes();
    await handlers({ calls, rows: { tiers: SEEDED_TIERS, settings: [{ payment_instructions: 'Bank: NCB 123', contact_email: 'team@caribwayz.test' }] } })
      .apply({ body: form() }, res);

    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.body.data, {
      application_id: APPLICATION_ID,
      tier: { name: '100 or more employees', annual_fee: 100, currency: 'USD', is_provisional: true },
      payment_instructions: 'Bank: NCB 123',
    });
    const v = insertedValues(calls);
    assert.equal(v.tier_id, 4, 'tier 4, whatever tier_id the form sent');
    assert.equal(v.quoted_fee, 100, 'quoted fee');
    assert.equal(v.description, null, 'an empty description is stored as null');
    assert.equal(v.business_email, null, 'an empty business email is stored as null');
    assert.equal(v.address, '1 King St');
    assert.equal(v.trading_name, 'Island Grill');
    assert.equal(v.latitude, null, 'no location given');
    assert.deepEqual(
      [v.business_name, v.category, v.phone, v.contact_name, v.contact_position, v.contact_phone, v.email],
      ['Island Grill Ltd', 'restaurant', '876-555-0100', 'Asha Brown', 'Owner', '876-555-0199', 'asha@grill.test'],
    );
    assert.deepEqual(v.terms_accepted_at, new Date('2026-10-30T12:00:00Z'), 'acceptance is stamped with the server time');
  });

  test('apply: a tier whose fee is not set quotes null, and no instructions answer ""', async () => {
    const calls = [];
    const res = makeRes();
    await handlers({ calls, rows: { tiers: SEEDED_TIERS, settings: [{ payment_instructions: '', contact_email: null }] } })
      .apply({ body: form({ employee_count: '50', latitude: 18.01, longitude: -76.8 }) }, res);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.body.data.tier, { name: '41-99 employees', annual_fee: null, currency: 'USD', is_provisional: true });
    assert.equal(res.body.data.payment_instructions, '');
    const v = insertedValues(calls);
    assert.equal(v.employee_count, 50);
    assert.equal(v.quoted_fee, null);
    assert.deepEqual([v.latitude, v.longitude], [18.01, -76.8]);
  });

  test('apply: no tier fits, so tier is null and nothing is quoted', async () => {
    const calls = [];
    const res = makeRes();
    await handlers({ calls, rows: { tiers: SEEDED_TIERS.slice(0, 2), settings: [] } })
      .apply({ body: form({ employee_count: 500 }) }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.tier, null);
    assert.equal(res.body.data.payment_instructions, '');
    const v = insertedValues(calls);
    assert.deepEqual([v.tier_id, v.quoted_fee], [null, null]);
  });

  test('apply: emails the settings contact address, or ADMIN_EMAIL when it is empty', async () => {
    for (const [contact, expected] of [['team@caribwayz.test', 'team@caribwayz.test'], [null, 'ops@caribwayz.test'], ['  ', 'ops@caribwayz.test']]) {
      const sent = [];
      await handlers({
        rows: { tiers: SEEDED_TIERS, settings: [{ payment_instructions: '', contact_email: contact }] },
        sendNotice: async (args) => { sent.push(args); },
      }).apply({ body: form() }, makeRes());
      await settle();
      assert.equal(sent.length, 1);
      assert.equal(sent[0].toEmail, expected);
      assert.equal(sent[0].application.id, APPLICATION_ID);
      assert.equal(sent[0].application.business_name, 'Island Grill Ltd');
      assert.equal(sent[0].application.trading_name, 'Island Grill');
      assert.equal(sent[0].application.contact_position, 'Owner');
      assert.equal(sent[0].tier.annual_fee, 100);
    }
  });

  test('apply: no email without SMTP, or without any contact address', async (t) => {
    const logged = silence(t);
    for (const opts of [{ configured: false }, { adminEmail: null }]) {
      const sent = [];
      const res = makeRes();
      await handlers({ ...opts, rows: { tiers: SEEDED_TIERS, settings: [{ payment_instructions: '', contact_email: null }] }, sendNotice: async (a) => { sent.push(a); } })
        .apply({ body: form() }, res);
      await settle();
      assert.equal(res.statusCode, 201);
      assert.equal(sent.length, 0);
    }
    assert.ok(logged.some((l) => /no contact email is set/.test(l)));
  });

  test('apply: a failed email still answers 201, and logs no address or name', async (t) => {
    const logged = silence(t);
    const res = makeRes();
    await handlers({
      rows: { tiers: SEEDED_TIERS, settings: [{ payment_instructions: '', contact_email: 'team@caribwayz.test' }] },
      sendNotice: async () => { throw new Error('Connection timeout'); },
    }).apply({ body: form() }, res);
    await settle();
    assert.equal(res.statusCode, 201);
    assert.equal(logged.length, 1);
    assert.match(logged[0], new RegExp(`application ${APPLICATION_ID}.*Connection timeout`));
    assert.doesNotMatch(logged[0], /asha|Island Grill|team@caribwayz/i);
  });

  test('apply: a database failure is a 500 and logs no form contents', async (t) => {
    const logged = silence(t);
    const failure = Object.assign(new Error('new row violates check constraint'), {
      code: '23514', detail: 'Failing row contains (Island Grill, asha@grill.test)',
    });
    const res = makeRes();
    await handlers({ rows: { tiers: SEEDED_TIERS, settings: [] }, fail: { insert: failure } }).apply({ body: form() }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.success, false);
    assert.equal(logged.length, 1);
    assert.doesNotMatch(logged[0], /asha|Island Grill/i);
  });
});

describe('member routes: validation and rate limit', () => {
  let server;
  let base;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/members', freshMembersRouter());
    ({ server, base } = await listen(app));
  });

  after(() => close(server));

  test('nearby: lat and lng are required and range-checked, radius_m must be whole -> 400', async () => {
    for (const q of [
      '', 'lat=18', 'lng=-76', 'lat=&lng=-76', 'lat=x&lng=-76', 'lat=91&lng=-76', 'lat=-90.5&lng=-76',
      'lat=18&lng=181', 'lat=18&lng=-180.01', 'lat=18&lng=-76&radius_m=far', 'lat=18&lng=-76&radius_m=1.5',
      'lat=18&lat=19&lng=-76',
    ]) {
      const res = await fetch(`${base}/members/nearby?${q}`);
      assert.equal(res.status, 400, q);
      const body = await res.json();
      assert.equal(body.success, false, q);
      assert.ok(Array.isArray(body.errors), q);
    }
  });

  const post = (body) => fetch(`${base}/members/apply`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  test('apply: each bad field is a 400 naming it, then the sixth request in an hour is 429', async () => {
    const good = GOOD_APPLICATION;
    const cases = [
      [{ ...good, business_name: 'A' }, 'business_name'],
      [{ ...good, email: 'not-an-email', contact_name: '   ' }, 'email'],
      [{ ...good, employee_count: 0, message: 'x'.repeat(2001) }, 'employee_count'],
      [{ ...good, employee_count: [5], latitude: 18 }, 'longitude'],
      [{ ...good, latitude: 91, longitude: -76, phone: 'call me' }, 'latitude'],
    ];
    for (const [body, field] of cases) {
      const res = await post(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      const fields = (await res.json()).errors.map((e) => e.path);
      assert.ok(fields.includes(field), `${field} in ${fields}`);
    }
    const limited = await post(good);
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), {
      success: false,
      message: 'Too many applications from this connection. Please wait an hour and try again, or email us.',
    });
  });

  test('apply: a website that is not http or https is a 400', async () => {
    const app = express();
    app.use(express.json());
    app.use('/members', freshMembersRouter());
    const { server: s, base: b } = await listen(app);
    try {
      for (const website of ['javascript:alert(1)', 'intent://scan/#Intent;end']) {
        const res = await fetch(`${b}/members/apply`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...GOOD_APPLICATION, website }),
        });
        assert.equal(res.status, 400, website);
        assert.deepEqual((await res.json()).errors.map((e) => e.path), ['website']);
      }
    } finally {
      await close(s);
    }
  });

  test('apply: a filled hidden field is answered 201 before validation or the database', async (t) => {
    silence(t);
    const app = express();
    app.use(express.json());
    app.use('/members', freshMembersRouter());
    const { server: s, base: b } = await listen(app);
    try {
      // Invalid on purpose: validation, or the database this test does not
      // have, would answer 400 or 500.
      const res = await fetch(`${b}/members/apply`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nope', [HONEYPOT_FIELD]: 'filled by a bot' }),
      });
      assert.equal(res.status, 201);
      assert.equal((await res.json()).data.tier, null);
    } finally {
      await close(s);
    }
  });

  test('apply: IPv6 senders are counted by /64, IPv4 by address', async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/members', freshMembersRouter());
    const { server: s, base: b } = await listen(app);
    const from = (ip) => fetch(`${b}/members/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: '{}',
    });
    try {
      // Five different addresses in one /64 share one count.
      for (let i = 1; i <= 5; i += 1) assert.equal((await from(`2001:db8:1:2::${i}`)).status, 400);
      assert.equal((await from('2001:db8:1:2:ffff::1')).status, 429, 'the sixth from the same /64');
      assert.equal((await from('2001:db8:1:3::1')).status, 400, 'the next /64 has its own count');
      assert.equal((await from('198.51.100.1')).status, 400);
      assert.equal((await from('198.51.100.2')).status, 400, 'each IPv4 address has its own count');
    } finally {
      await close(s);
    }
  });

  test('apply: every field the contract limits is checked', async () => {
    // A fresh router: the test above used up this one's limit.
    const app = express();
    app.use(express.json());
    app.use('/members', freshMembersRouter());
    const { server: s, base: b } = await listen(app);
    try {
      const res = await fetch(`${b}/members/apply`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ employee_count: 1000001, message: 'x'.repeat(2001), website: 5, longitude: -76 }),
      });
      assert.equal(res.status, 400);
      const fields = (await res.json()).errors.map((e) => e.path);
      for (const field of ['business_name', 'contact_name', 'email', 'employee_count', 'message', 'website', 'longitude']) {
        assert.ok(fields.includes(field), `${field} in ${fields}`);
      }
    } finally {
      await close(s);
    }
  });

  test('apply: the required details of the policy, their limits, and acceptance as JSON true', async () => {
    // Each request on a fresh router, so the five-an-hour limit never answers first.
    const send = async (body) => {
      const app = express();
      app.use(express.json());
      app.use('/members', freshMembersRouter());
      const { server: s, base: b } = await listen(app);
      try {
        const res = await fetch(`${b}/members/apply`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        assert.equal(res.status, 400, JSON.stringify(body));
        return (await res.json()).errors.map((e) => e.path).sort();
      } finally {
        await close(s);
      }
    };

    const required = ['accept_terms', 'address', 'category', 'contact_phone', 'contact_position', 'phone'];
    const missing = { ...GOOD_APPLICATION };
    for (const field of required) delete missing[field];
    assert.deepEqual(await send(missing), required);

    const blank = { ...GOOD_APPLICATION, category: '  ', address: '', phone: ' ', contact_position: '	', contact_phone: '' };
    assert.deepEqual(await send(blank), ['address', 'category', 'contact_phone', 'contact_position', 'phone']);

    // Acceptance must be the JSON value true, not a truthy look-alike.
    for (const accept of [false, 'true', 1, 'on', null]) {
      assert.deepEqual(await send({ ...GOOD_APPLICATION, accept_terms: accept }), ['accept_terms'], String(accept));
    }

    assert.deepEqual(await send({
      ...GOOD_APPLICATION,
      trading_name: 'x'.repeat(201), description: 'x'.repeat(1001), business_email: 'not-an-email',
      contact_position: 'x'.repeat(101), contact_phone: 'ring me',
    }), ['business_email', 'contact_phone', 'contact_position', 'description', 'trading_name']);
  });
});

describe('admin member routes: access and validation', () => {
  let server;
  let base;
  let sessionCheck;
  let userToken;
  let adminToken;

  before(async () => {
    // Every token names its sign-in session, which authenticate checks is
    // still live. There is no database here, so every session counts as live.
    sessionCheck = mock.method(require('../src/services/sessionService').sessionService(), 'isSessionActive', async () => true);
    const { generateToken } = require('../src/utils/jwt');
    userToken = generateToken({ id: USER_ID, email: 'u@example.com', role: 'user', sid: SESSION_ID });
    adminToken = generateToken({ id: ADMIN_ID, email: 'a@example.com', role: 'admin', sid: SESSION_ID });
    const app = express();
    app.use(express.json());
    app.use('/admin', require('../src/routes/admin'));
    app.use((req, res) => res.status(404).json({ success: false, message: 'Route not found' }));
    ({ server, base } = await listen(app));
  });

  after(async () => {
    sessionCheck.mock.restore();
    await close(server);
  });

  const call = async (method, url, body, token) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  const ADMIN_ROUTES = [
    ['GET', '/admin/membership-tiers'],
    ['POST', '/admin/membership-tiers', { name: 'X', min_employees: 1 }],
    ['PATCH', '/admin/membership-tiers/1', { annual_fee: 10 }],
    ['GET', '/admin/membership-applications'],
    ['PATCH', `/admin/membership-applications/${APPLICATION_ID}`, { status: 'invoiced' }],
    ['POST', `/admin/membership-applications/${APPLICATION_ID}/activate`, {}],
    ['GET', '/admin/businesses'],
    ['POST', '/admin/businesses', { name: 'X', latitude: 18, longitude: -76 }],
    ['PATCH', `/admin/businesses/${BUSINESS_ID}`, { promo_text: 'x' }],
    ['GET', '/admin/membership-settings'],
    ['PUT', '/admin/membership-settings', { payment_instructions: 'x' }],
  ];

  test('every admin member endpoint needs a sign-in (401) and an admin (403)', async () => {
    for (const [method, url, body] of ADMIN_ROUTES) {
      assert.equal((await call(method, url, body)).status, 401, `${method} ${url} without a token`);
      assert.equal((await call(method, url, body, userToken)).status, 403, `${method} ${url} as a user`);
    }
  });

  test('the sponsorship admin routes are gone', async () => {
    assert.equal((await call('GET', '/admin/sponsorships', undefined, adminToken)).status, 404);
    assert.equal((await call('PATCH', '/admin/sponsorships/1', { status: 'active' }, adminToken)).status, 404);
  });

  test('bad admin input is refused before the database (422)', async () => {
    const cases = [
      ['POST', '/admin/businesses', { latitude: 18, longitude: -76 }, 'name'],
      ['POST', '/admin/businesses', { name: 'X', latitude: 91, longitude: -76 }, 'latitude'],
      ['POST', '/admin/businesses', { name: 'X', latitude: 18, longitude: -76, membership_status: 'gold' }, 'membership_status'],
      ['POST', '/admin/businesses', { name: 'X', latitude: 18, longitude: -76, promo_text: 'x'.repeat(281) }, 'promo_text'],
      ['POST', '/admin/businesses', { name: 'X', latitude: 18, longitude: -76, promo_expires_at: 'soon' }, 'promo_expires_at'],
      ['POST', '/admin/businesses', { name: 'X', latitude: 18, longitude: -76, contact_email: 'nope' }, 'contact_email'],
      ['PATCH', `/admin/businesses/${BUSINESS_ID}`, { latitude: 18 }, 'longitude'],
      ['PATCH', `/admin/businesses/${BUSINESS_ID}`, { name: '' }, 'name'],
      ['PATCH', `/admin/businesses/${BUSINESS_ID}`, { is_active: 'yes' }, 'is_active'],
      ['PATCH', '/admin/businesses/not-a-uuid', { promo_text: 'x' }, 'id'],
      ['POST', '/admin/membership-tiers', { name: 'X' }, 'min_employees'],
      ['POST', '/admin/membership-tiers', { name: 'X', min_employees: 1, annual_fee: -1 }, 'annual_fee'],
      ['POST', '/admin/membership-tiers', { name: 'X', min_employees: 1, currency: 'usd' }, 'currency'],
      ['PATCH', '/admin/membership-tiers/1', { min_employees: null }, 'min_employees'],
      ['GET', '/admin/membership-applications?status=lost', undefined, 'status'],
      ['PATCH', `/admin/membership-applications/${APPLICATION_ID}`, { status: 'won' }, 'status'],
      ['POST', `/admin/membership-applications/${APPLICATION_ID}/activate`, { months: 0 }, 'months'],
      ['POST', `/admin/membership-applications/${APPLICATION_ID}/activate`, { latitude: 18 }, 'longitude'],
      ['PUT', '/admin/membership-settings', { contact_email: 'nope' }, 'contact_email'],
      ['POST', '/admin/businesses', { name: 'X', latitude: 18, longitude: -76, membership_expires_at: '1' }, 'membership_expires_at'],
      ['POST', '/admin/businesses', { name: 'X', latitude: 18, longitude: -76, promo_expires_at: '2026' }, 'promo_expires_at'],
      ['POST', '/admin/businesses', { name: 'X', latitude: 18, longitude: -76, promo_expires_at: '2026-02-30T00:00:00Z' }, 'promo_expires_at'],
      ['POST', '/admin/businesses', { name: 'X', latitude: 18, longitude: -76, membership_expires_at: false }, 'membership_expires_at'],
      ['POST', '/admin/businesses', { name: 'X', latitude: 18, longitude: -76, tier_id: 2147483648 }, 'tier_id'],
      ['POST', '/admin/businesses', { name: 'X', latitude: 18, longitude: -76, phone: '1'.repeat(41) }, 'phone'],
      ['POST', '/admin/businesses', { name: 'X', latitude: 18, longitude: -76, website: 'javascript:alert(1)' }, 'website'],
      ['PATCH', `/admin/businesses/${BUSINESS_ID}`, { website: 'intent://scan/#Intent;end' }, 'website'],
      ['POST', '/admin/membership-tiers', { name: 'X', min_employees: 1, sort_order: 2147483648 }, 'sort_order'],
      ['PATCH', '/admin/membership-tiers/2147483648', { name: 'X' }, 'id'],
    ];
    for (const [method, url, body, field] of cases) {
      const res = await call(method, url, body, adminToken);
      assert.equal(res.status, 422, `${method} ${url} ${JSON.stringify(body)}`);
      assert.ok(res.body.errors.map((e) => e.path).includes(field), `${field} in ${JSON.stringify(res.body.errors)}`);
    }
  });
});

describe('admin member handlers', () => {
  const fakeQuery = (calls, answer = () => ({ rows: [{ id: BUSINESS_ID }] })) => async (text, params) => {
    calls.push({ text, params });
    return answer(text, params);
  };

  test('updating a business touches only the fields sent, and null or "" clears one', async () => {
    const calls = [];
    const { updateBusiness } = buildMemberAdminHandlers({ query: fakeQuery(calls), getClient: null });
    const res = makeRes();
    await updateBusiness({ params: { id: BUSINESS_ID }, body: { promo_text: null, promo_expires_at: '', name: 'New name', bogus: 1 } }, res);
    assert.equal(res.statusCode, 200);
    assert.match(calls[0].text, /^UPDATE businesses SET name = \$1, promo_text = \$2, promo_expires_at = \$3, updated_at = NOW\(\) WHERE id = \$4/);
    assert.deepEqual(calls[0].params, ['New name', null, null, BUSINESS_ID]);
  });

  test('updating with nothing is 400; an unknown business 404; an unknown tier 400', async (t) => {
    silence(t);
    const { updateBusiness } = buildMemberAdminHandlers({ query: fakeQuery([], () => ({ rows: [] })), getClient: null });
    let res = makeRes();
    await updateBusiness({ params: { id: BUSINESS_ID }, body: {} }, res);
    assert.equal(res.statusCode, 400);
    res = makeRes();
    await updateBusiness({ params: { id: BUSINESS_ID }, body: { name: 'X' } }, res);
    assert.equal(res.statusCode, 404);

    const fk = buildMemberAdminHandlers({
      query: async () => { throw Object.assign(new Error('fk'), { code: '23503' }); }, getClient: null,
    });
    res = makeRes();
    await fk.updateBusiness({ params: { id: BUSINESS_ID }, body: { tier_id: 99 } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.message, 'That membership tier does not exist');
  });

  test('adding a business defaults to pending and records the admin', async () => {
    const calls = [];
    const { addBusiness } = buildMemberAdminHandlers({
      query: fakeQuery(calls, (text) => ({ rows: [{ id: BUSINESS_ID, latitude: '18.00000000', longitude: '-76.00000000' }] })), getClient: null,
    });
    const res = makeRes();
    await addBusiness({ user: { id: ADMIN_ID }, body: { name: 'Island Grill', latitude: 18, longitude: -76 } }, res);
    assert.equal(res.statusCode, 201);
    assert.match(calls[0].text, /INSERT INTO businesses \(name, latitude, longitude, membership_status, created_by\)/);
    assert.deepEqual(calls[0].params, ['Island Grill', 18, -76, 'pending', ADMIN_ID]);
    assert.equal(res.body.data.business.latitude, 18);
  });

  test('a tier whose maximum is below its minimum is a 400, not a 500', async () => {
    const { addTier } = buildMemberAdminHandlers({
      query: async () => { throw Object.assign(new Error('check'), { code: '23514', constraint: 'membership_tiers_check' }); },
      getClient: null,
    });
    const res = makeRes();
    await addTier({ body: { name: 'X', min_employees: 10, max_employees: 5 } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.message, 'Maximum employees must be at least the minimum');
  });

  test('settings: only the fields sent change', async () => {
    const calls = [];
    const { updateSettings } = buildMemberAdminHandlers({
      query: fakeQuery(calls, () => ({ rows: [{ payment_instructions: 'Bank', contact_email: null }] })), getClient: null,
    });
    const res = makeRes();
    await updateSettings({ body: { payment_instructions: 'Bank' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls[0].params, ['Bank', null, true, false]);
  });

  /** A transaction client that answers by statement and records them. */
  const fakeClient = ({ application, linked = null, linkedStatus = 'active', failOn } = {}) => {
    const statements = [];
    let released = 0;
    const client = {
      statements,
      get released() { return released; },
      release: () => { released += 1; },
      query: async (text, params) => {
        statements.push({ text, params });
        if (failOn && failOn.test(text)) throw new Error('db down');
        if (/FROM membership_applications WHERE id/.test(text)) return { rows: application ? [application] : [] };
        if (/SELECT id, membership_status FROM businesses/.test(text)) {
          return { rows: linked ? [{ id: linked, membership_status: linkedStatus }] : [] };
        }
        if (/INSERT INTO businesses/.test(text)) return { rows: [{ id: BUSINESS_ID }] };
        if (/UPDATE businesses/.test(text)) return { rows: [{ id: linked }] };
        return { rows: [] };
      },
    };
    return client;
  };

  const APPLICATION = {
    id: APPLICATION_ID, business_name: 'Island Grill', category: 'restaurant', address: '1 King St', phone: null,
    website: null, tier_id: 4, employee_count: 120, contact_name: 'Asha Brown', email: 'asha@grill.test',
    latitude: null, longitude: null, business_id: null,
  };

  const activator = (client) => buildMemberAdminHandlers({
    query: async (text) => ({ rows: [/membership_applications/.test(text) ? { id: APPLICATION_ID, quoted_fee: '100.00' } : { id: BUSINESS_ID, latitude: '18.00000000', longitude: '-76.00000000' }] }),
    getClient: async () => client,
  }).activateApplication;

  test('activate: creates an active member for 12 months, marks the application paid and links it', async () => {
    const client = fakeClient({ application: APPLICATION });
    const res = makeRes();
    await activator(client)({ params: { id: APPLICATION_ID }, user: { id: ADMIN_ID }, body: { latitude: 18, longitude: -76 } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'Membership activated');
    const texts = client.statements.map((s) => s.text);
    assert.equal(texts[0], 'BEGIN');
    assert.equal(texts[texts.length - 1], 'COMMIT');
    const insert = client.statements.find((s) => /INSERT INTO businesses/.test(s.text));
    assert.match(insert.text, /'active', NOW\(\) \+ make_interval\(months => \$11\)/);
    assert.deepEqual(insert.params, [
      'Island Grill', 'restaurant', 18, -76, '1 King St', null, null, 4, 120, 'asha@grill.test', 12, ADMIN_ID,
      'Island Grill', null, null, 'Asha Brown', null, null,
    ], 'an application from before migration 027 has no new details: they are null, and the name is the registered one');
    const paid = client.statements.find((s) => /UPDATE membership_applications SET status = 'paid'/.test(s.text));
    assert.deepEqual(paid.params, [BUSINESS_ID, APPLICATION_ID]);
    assert.equal(client.released, 1);
    assert.equal(res.body.data.application.quoted_fee, 100);
  });

  test('activate: renews the linked business for the months given, without a new one', async () => {
    const LINKED = '88888888-7777-4666-8555-444444444444';
    const client = fakeClient({ application: { ...APPLICATION, business_id: LINKED }, linked: LINKED });
    const res = makeRes();
    await activator(client)({ params: { id: APPLICATION_ID }, user: { id: ADMIN_ID }, body: { months: 6 } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'Membership renewed');
    assert.ok(!client.statements.some((s) => /INSERT INTO businesses/.test(s.text)));
    const update = client.statements.find((s) => /UPDATE businesses SET/.test(s.text));
    assert.deepEqual(update.params, [6, null, null, 4, LINKED]);
  });

  test('activate: the listing shows the trading name and keeps the registered name and the policy details', async () => {
    const client = fakeClient({
      application: {
        ...APPLICATION, business_name: 'Island Grill Ltd', trading_name: '  Island Grill  ', description: 'Jerk by the sea',
        business_email: 'hello@grill.test', contact_position: 'Owner', contact_phone: '876-555-0199', phone: '876-555-0100',
      },
    });
    const res = makeRes();
    await activator(client)({ params: { id: APPLICATION_ID }, user: { id: ADMIN_ID }, body: { latitude: 18, longitude: -76 } }, res);
    assert.equal(res.statusCode, 200);
    const insert = client.statements.find((s) => /INSERT INTO businesses/.test(s.text));
    const columns = insert.text.match(/\(([^)]+)\)\s*VALUES/)[1].split(',').map((c) => c.trim());
    assert.deepEqual(columns.slice(-6), ['registered_name', 'description', 'business_email', 'contact_name', 'contact_position', 'contact_phone']);
    assert.equal(insert.params[0], 'Island Grill', 'name: the trading name, trimmed');
    assert.equal(insert.params[5], '876-555-0100', 'phone: the business telephone');
    assert.deepEqual(insert.params.slice(-6), ['Island Grill Ltd', 'Jerk by the sea', 'hello@grill.test', 'Asha Brown', 'Owner', '876-555-0199']);
  });

  test('activate: renewing a suspended business is refused (409), rolled back, nothing written', async () => {
    const LINKED = '88888888-7777-4666-8555-444444444444';
    const client = fakeClient({ application: { ...APPLICATION, business_id: LINKED }, linked: LINKED, linkedStatus: 'suspended' });
    const res = makeRes();
    await activator(client)({ params: { id: APPLICATION_ID }, user: { id: ADMIN_ID }, body: { months: 12 } }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /suspended\. Lift the suspension/);
    assert.ok(!client.statements.some((s) => /^\s*(INSERT|UPDATE)/.test(s.text)), 'nothing written');
    assert.equal(client.statements[client.statements.length - 1].text, 'ROLLBACK');
    assert.equal(client.released, 1);
  });

  test('activate: renewing a cancelled or expired business still works', async () => {
    const LINKED = '88888888-7777-4666-8555-444444444444';
    for (const status of ['cancelled', 'expired', 'pending']) {
      const client = fakeClient({ application: { ...APPLICATION, business_id: LINKED }, linked: LINKED, linkedStatus: status });
      const res = makeRes();
      await activator(client)({ params: { id: APPLICATION_ID }, user: { id: ADMIN_ID }, body: {} }, res);
      assert.equal(res.statusCode, 200, status);
      assert.equal(res.body.message, 'Membership renewed', status);
    }
  });

  test('activate: uses the location on the application when none is given', async () => {
    const client = fakeClient({ application: { ...APPLICATION, latitude: 18.5, longitude: -77.1 } });
    const res = makeRes();
    await activator(client)({ params: { id: APPLICATION_ID }, user: { id: ADMIN_ID }, body: {} }, res);
    assert.equal(res.statusCode, 200);
    const insert = client.statements.find((s) => /INSERT INTO businesses/.test(s.text));
    assert.deepEqual([insert.params[2], insert.params[3]], [18.5, -77.1]);
  });

  test('activate: no location anywhere is a 400, rolled back', async () => {
    const client = fakeClient({ application: APPLICATION });
    const res = makeRes();
    await activator(client)({ params: { id: APPLICATION_ID }, user: { id: ADMIN_ID }, body: {} }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /no location/);
    assert.equal(client.statements[client.statements.length - 1].text, 'ROLLBACK');
    assert.equal(client.released, 1);
  });

  test('activate: an unknown application is a 404, rolled back', async () => {
    const client = fakeClient({ application: null });
    const res = makeRes();
    await activator(client)({ params: { id: APPLICATION_ID }, user: { id: ADMIN_ID }, body: {} }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(client.statements[client.statements.length - 1].text, 'ROLLBACK');
    assert.equal(client.released, 1);
  });

  test('activate: a failure part way is rolled back, a 500, and the client released', async (t) => {
    const logged = silence(t);
    const client = fakeClient({ application: APPLICATION, failOn: /UPDATE membership_applications/ });
    const res = makeRes();
    await activator(client)({ params: { id: APPLICATION_ID }, user: { id: ADMIN_ID }, body: { latitude: 18, longitude: -76 } }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(client.statements[client.statements.length - 1].text, 'ROLLBACK');
    assert.ok(!client.statements.some((s) => s.text === 'COMMIT'));
    assert.equal(client.released, 1);
    assert.equal(logged.length, 1);
  });

  test('activate: a rejected application is refused (409) and rolled back', async () => {
    const client = fakeClient({ application: { ...APPLICATION, status: 'rejected' } });
    const res = makeRes();
    await activator(client)({ params: { id: APPLICATION_ID }, user: { id: ADMIN_ID }, body: { latitude: 18, longitude: -76 } }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /rejected\. Reopen it/);
    assert.ok(!client.statements.some((s) => /^(INSERT|UPDATE)/.test(s.text)), 'nothing written');
    assert.equal(client.statements[client.statements.length - 1].text, 'ROLLBACK');
    assert.equal(client.released, 1);
  });

  test('activate: a renewal extends from a future expiry, else from now', async () => {
    const LINKED = '88888888-7777-4666-8555-444444444444';
    const client = fakeClient({ application: { ...APPLICATION, business_id: LINKED }, linked: LINKED });
    await activator(client)({ params: { id: APPLICATION_ID }, user: { id: ADMIN_ID }, body: {} }, makeRes());
    const update = client.statements.find((s) => /UPDATE businesses SET/.test(s.text));
    assert.match(update.text, /CASE\s+WHEN membership_expires_at > NOW\(\) THEN membership_expires_at\s+ELSE NOW\(\)\s+END \+ make_interval\(months => \$1\)/);
  });

  test('activate: no database connection is a 500', async (t) => {
    silence(t);
    const { activateApplication } = buildMemberAdminHandlers({
      query: async () => ({ rows: [] }), getClient: async () => { throw new Error('pool exhausted'); },
    });
    const res = makeRes();
    await activateApplication({ params: { id: APPLICATION_ID }, user: { id: ADMIN_ID }, body: {} }, res);
    assert.equal(res.statusCode, 500);
  });
});

describe('the application notice email', () => {
  /** emailService loaded with nodemailer's transport replaced by a recorder. */
  const loadMailer = (t, sendMail) => {
    const nodemailer = require('nodemailer');
    t.mock.method(nodemailer, 'createTransport', () => ({ sendMail }));
    delete require.cache[src('services/emailService')];
    try {
      return require(src('services/emailService'));
    } finally {
      delete require.cache[src('services/emailService')];
    }
  };

  const application = {
    id: APPLICATION_ID, business_name: 'Grill <b>\r\nBcc: x@evil.test', contact_name: 'Asha', email: 'asha@grill.test',
    phone: null, address: null, category: null, employee_count: 120, website: null, message: '<script>alert(1)</script>',
  };

  test('escapes what the business typed, and keeps the subject on one line', async (t) => {
    const sent = [];
    const { sendMembershipApplicationNotice } = loadMailer(t, async (mail) => { sent.push(mail); });
    await sendMembershipApplicationNotice({
      toEmail: 'team@caribwayz.test', application,
      tier: { name: '100 or more employees', annual_fee: 100, currency: 'USD', is_provisional: true },
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'team@caribwayz.test');
    assert.doesNotMatch(sent[0].subject, /[\r\n]/);
    assert.doesNotMatch(sent[0].html, /<script>|<b>/);
    assert.match(sent[0].html, /&lt;script&gt;/);
    assert.match(sent[0].text, /USD 100\.00 a year \(provisional\)/);
    assert.doesNotMatch(sent[0].text, /Phone:/, 'empty fields are left out');
  });

  test('lists the registration details of the policy, escaped, with the empty ones left out', async (t) => {
    const sent = [];
    const { sendMembershipApplicationNotice } = loadMailer(t, async (mail) => { sent.push(mail); });
    await sendMembershipApplicationNotice({
      toEmail: 'team@caribwayz.test',
      application: {
        ...application, business_name: 'Island Grill Ltd', trading_name: 'Island <Grill>', description: null,
        phone: '876-555-0100', business_email: 'hello@grill.test', contact_position: 'Owner', contact_phone: '876-555-0199',
      },
      tier: null,
    });
    const { text, html } = sent[0];
    for (const line of [
      'Registered name: Island Grill Ltd', 'Trading name: Island <Grill>', 'Business phone: 876-555-0100',
      'Business email: hello@grill.test', 'Contact: Asha', 'Position: Owner', 'Contact phone: 876-555-0199',
      'Contact email: asha@grill.test',
    ]) {
      assert.ok(text.includes(line), line);
    }
    assert.doesNotMatch(text, /Description:/);
    assert.match(html, /Island &lt;Grill&gt;/);
  });

  test('says when the fee is not set or no tier fits', async (t) => {
    const sent = [];
    const { sendMembershipApplicationNotice } = loadMailer(t, async (mail) => { sent.push(mail); });
    await sendMembershipApplicationNotice({ toEmail: 'team@caribwayz.test', application, tier: { name: '41-99 employees', annual_fee: null, currency: 'USD', is_provisional: true } });
    await sendMembershipApplicationNotice({ toEmail: 'team@caribwayz.test', application, tier: null });
    assert.match(sent[0].text, /41-99 employees: fee to be confirmed/);
    assert.match(sent[1].text, /No tier fits/);
  });

  test('refuses a bad recipient or a missing application before sending', async (t) => {
    const sent = [];
    const { sendMembershipApplicationNotice } = loadMailer(t, async (mail) => { sent.push(mail); });
    for (const toEmail of ['', 'no-at-sign', 'a@b.test\r\nBcc: c@d.test', 'a@b.test, c@d.test', undefined]) {
      await assert.rejects(sendMembershipApplicationNotice({ toEmail, application, tier: null }), /recipient/);
    }
    await assert.rejects(sendMembershipApplicationNotice({ toEmail: 'a@b.test', application: null, tier: null }), /application/);
    assert.equal(sent.length, 0);
  });

  test('a mail server failure is thrown to the caller', async (t) => {
    const { sendMembershipApplicationNotice } = loadMailer(t, async () => { throw new Error('ECONNREFUSED'); });
    await assert.rejects(sendMembershipApplicationNotice({ toEmail: 'a@b.test', application, tier: null }), /ECONNREFUSED/);
  });
});

/** The client's final tiers (2026-11-09) as migration 026 leaves them, as pg returns them. */
const FINAL_TIERS = [
  { name: 'Micro', min_employees: 1, max_employees: 5, annual_fee: '20.00', is_provisional: false },
  { name: 'Small', min_employees: 6, max_employees: 20, annual_fee: '40.00', is_provisional: false },
  { name: 'Medium', min_employees: 21, max_employees: 50, annual_fee: '75.00', is_provisional: false },
  { name: 'Corporate', min_employees: 51, max_employees: null, annual_fee: '125.00', is_provisional: false },
];

describe('member businesses against Postgres', { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL to a throwaway database' }, () => {
  let server;
  let base;
  let pool;
  const stamp = Date.now();
  const users = {};
  const tokens = {};
  let savedSettings;
  const q = (text, params) => pool.query(text, params);
  // A quiet spot off Jamaica's south coast, so other tests' rows are never near.
  const HERE = { lat: 17.2, lng: -77.3 };
  // About [metres] north of HERE.
  const north = (metres) => HERE.lat + metres / 111195;

  const call = async (who, method, url, body) => {
    const headers = { 'content-type': 'application/json' };
    if (who) headers.authorization = `Bearer ${tokens[who]}`;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  // The details the policy requires on every application (migration 027).
  // No trading name, so the listing keeps the business name the test gives.
  const POLICY = Object.freeze({
    category: 'hotel', address: '1 Test Road, Kingston', phone: '876-555-0100',
    contact_position: 'Owner', contact_phone: '876-555-0199', accept_terms: true,
  });

  const addMember = (name, metres, extra = {}) => q(
    `INSERT INTO businesses (name, category, latitude, longitude, membership_status, membership_expires_at, is_active, promo_text, promo_expires_at)
     VALUES ($1, 'restaurant', $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [`${name} ${stamp}`, north(metres), HERE.lng, extra.status || 'active', extra.expires === undefined ? null : extra.expires,
     extra.is_active === undefined ? true : extra.is_active, extra.promo || null, extra.promoExpires || null]
  );

  before(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL);
    Object.assign(process.env, {
      DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: url.pathname.slice(1),
      DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password),
    });
    delete process.env.DATABASE_URL;
    for (const mod of [
      'config/db', 'services/sessionService', 'middleware/auth', 'services/notificationService',
      'controllers/adminController', 'controllers/membershipController', 'controllers/memberAdminController',
      'routes/admin', 'routes/members', 'middleware/rateLimits', 'migrations/migrate',
    ]) {
      delete require.cache[src(mod)];
    }
    const quietLog = console.log;
    console.log = () => {};
    try {
      // Twice: every migration must be safe to re-run on each boot.
      await require('../src/migrations/migrate')();
      await require('../src/migrations/migrate')();
    } finally {
      console.log = quietLog;
    }
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    savedSettings = (await q('SELECT payment_instructions, contact_email FROM membership_settings WHERE id = TRUE')).rows[0];

    for (const [key, role] of [['boss', 'admin'], ['ann', 'user']]) {
      users[key] = (await q(
        `INSERT INTO users (name, email, role, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
        [`Members ${key}`, `${key}-${stamp}@members.test`, role]
      )).rows[0].id;
    }
    const { generateToken } = require('../src/utils/jwt');
    for (const [k, id] of Object.entries(users)) {
      const sid = require('node:crypto').randomUUID();
      await q(`INSERT INTO user_sessions (id, user_id, method, platform, expires_at)
               VALUES ($1, $2, 'email', 'android', NOW() + INTERVAL '1 day')`, [sid, id]);
      tokens[k] = generateToken({ id, email: `${k}@members.test`, role: k === 'boss' ? 'admin' : 'user', sid });
    }

    const app = express();
    app.use(express.json());
    app.use('/members', require('../src/routes/members'));
    app.use('/admin', require('../src/routes/admin'));
    ({ server, base } = await listen(app));
  });

  after(async () => {
    if (server) await close(server);
    if (pool) {
      await q(`DELETE FROM membership_applications WHERE email LIKE $1`, [`%-${stamp}@members.test`]);
      await q(`DELETE FROM businesses WHERE name LIKE $1`, [`% ${stamp}`]);
      await q(`DELETE FROM membership_tiers WHERE name LIKE $1`, [`% ${stamp}`]);
      await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [Object.values(users)]);
      if (savedSettings) {
        await q('UPDATE membership_settings SET payment_instructions = $1, contact_email = $2 WHERE id = TRUE',
          [savedSettings.payment_instructions, savedSettings.contact_email]);
      }
      await pool.end();
    }
    await require('../src/config/db').pool.end();
  });

  test('migrations 025 then 026 leave the four final tiers, and 025 adds the columns admin add-business writes', async () => {
    const seeded = (await q(`SELECT name, min_employees, max_employees, annual_fee, is_provisional
                               FROM membership_tiers WHERE name NOT LIKE '% ${stamp}' ORDER BY sort_order`)).rows;
    assert.deepEqual(seeded, FINAL_TIERS);
    const columns = (await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'businesses'`)).rows.map((r) => r.column_name);
    for (const c of ['membership_tier', 'business_size', 'tier_id', 'employee_count', 'contact_email', 'membership_status',
      'membership_expires_at', 'promo_text', 'promo_expires_at', 'updated_at']) {
      assert.ok(columns.includes(c), c);
    }
    assert.equal((await q('SELECT COUNT(*)::int AS n FROM membership_settings')).rows[0].n, 1);
    await assert.rejects(
      q(`INSERT INTO businesses (name, latitude, longitude, membership_status) VALUES ('x ${stamp}', 0, 0, 'gold')`),
      /membership_status_check/
    );
  });

  test('migration 026: replaces only the untouched 025 seed, re-tiers by employee count, keeps quoted fees', async () => {
    const sql026 = require('node:fs').readFileSync(src('migrations/026_final_membership_tiers.sql'), 'utf8');
    const own = `name NOT LIKE '% ${stamp}'`;
    const tiersNow = async () => (await q(`SELECT name, min_employees, max_employees, annual_fee, is_provisional
                                             FROM membership_tiers WHERE ${own} ORDER BY sort_order`)).rows;
    const toSeed = () => q(`UPDATE membership_tiers t
         SET name = v.name, min_employees = v.lo, max_employees = v.hi, annual_fee = v.fee, is_provisional = TRUE
        FROM (VALUES (1, '1-15 employees', 1, 15, 20.00), (2, '16-40 employees', 16, 40, 50.00),
                     (3, '41-99 employees', 41, 99, NULL), (4, '100 or more employees', 100, NULL, 100.00))
             AS v(so, name, lo, hi, fee)
       WHERE t.sort_order = v.so AND t.${own}`);
    const tierId = async (sortOrder) => (await q(
      `SELECT id FROM membership_tiers WHERE sort_order = $1 AND ${own}`, [sortOrder])).rows[0].id;
    const bizTier = async (id) => (await q('SELECT tier_id FROM businesses WHERE id = $1', [id])).rows[0].tier_id;
    assert.equal((await q(`SELECT COUNT(*)::int AS n FROM membership_tiers WHERE NOT (${own})`)).rows[0].n, 0,
      'runs before any test adds a tier, or the table is not the bare seed');

    await toSeed();
    // Ten employees sat in the old first tier (1-15); under the final tiers that is Small.
    const biz = (await q(`INSERT INTO businesses (name, latitude, longitude, employee_count, tier_id, membership_status)
                          VALUES ($1, 0, 0, 10, $2, 'pending') RETURNING id`, [`Retier ${stamp}`, await tierId(1)])).rows[0].id;
    const noCount = (await q(`INSERT INTO businesses (name, latitude, longitude, tier_id, membership_status)
                              VALUES ($1, 0, 0, $2, 'pending') RETURNING id`, [`No count ${stamp}`, await tierId(2)])).rows[0].id;
    const app = (await q(`INSERT INTO membership_applications (business_name, contact_name, email, employee_count, tier_id, quoted_fee)
                          VALUES ($1, 'Cy', $2, 60, $3, NULL) RETURNING id`,
      [`Retier app ${stamp}`, `cy-${stamp}@members.test`, await tierId(3)])).rows[0].id;

    await q(sql026);
    assert.deepEqual(await tiersNow(), FINAL_TIERS);
    assert.equal(await bizTier(biz), await tierId(2));
    assert.equal(await bizTier(noCount), await tierId(2), 'no employee count: tier left as it was');
    assert.deepEqual((await q('SELECT tier_id, quoted_fee FROM membership_applications WHERE id = $1', [app])).rows[0],
      { tier_id: await tierId(4), quoted_fee: null }, 'quoted fee is what they were told');

    // Re-running on the next boot changes nothing, not even a tier an admin set by hand.
    await q('UPDATE businesses SET tier_id = $1 WHERE id = $2', [await tierId(1), biz]);
    await q(sql026);
    assert.deepEqual(await tiersNow(), FINAL_TIERS);
    assert.equal(await bizTier(biz), await tierId(1));

    // A seed an admin has already edited (one fee changed) is left alone.
    await toSeed();
    await q(`UPDATE membership_tiers SET annual_fee = 30 WHERE sort_order = 1 AND ${own}`);
    await q(sql026);
    const edited = await tiersNow();
    assert.deepEqual([edited[0].name, edited[0].annual_fee, edited[0].is_provisional], ['1-15 employees', '30.00', true]);

    // Back to the final tiers for the rest of the suite.
    await q(`UPDATE membership_tiers SET annual_fee = 20 WHERE sort_order = 1 AND ${own}`);
    await q(sql026);
    assert.deepEqual(await tiersNow(), FINAL_TIERS);
    await q('DELETE FROM membership_applications WHERE id = $1', [app]);
  });

  test('nearby: only listed, active, unexpired members inside the radius, nearest first, as numbers', async () => {
    const day = 24 * 60 * 60 * 1000;
    await addMember('Near', 100, { promo: '10% off', promoExpires: new Date(Date.now() + day) });
    await addMember('Middle', 900, { expires: new Date(Date.now() + day), promo: 'Old deal', promoExpires: new Date(Date.now() - day) });
    await addMember('Expired', 200, { expires: new Date(Date.now() - day) });
    await addMember('Pending', 300, { status: 'pending' });
    await addMember('Cancelled', 350, { status: 'cancelled' });
    await addMember('Unlisted', 400, { is_active: false });
    await addMember('Far', 2500);

    const res = await call(null, 'GET', `/members/nearby?lat=${HERE.lat}&lng=${HERE.lng}`);
    assert.equal(res.status, 200);
    const members = res.body.data.members;
    assert.deepEqual(members.map((m) => m.name), [`Near ${stamp}`, `Middle ${stamp}`]);
    assert.equal(members[0].promo_text, '10% off');
    assert.equal(members[1].promo_text, null, 'expired promotion');
    for (const m of members) {
      assert.equal(typeof m.latitude, 'number');
      assert.equal(typeof m.longitude, 'number');
      assert.ok(Number.isInteger(m.distance_m));
    }
    assert.ok(Math.abs(members[0].distance_m - 100) <= 2, `${members[0].distance_m} m`);
    assert.ok(Math.abs(members[1].distance_m - 900) <= 5, `${members[1].distance_m} m`);
    assert.deepEqual(Object.keys(members[0]).sort(), ['address', 'category', 'description', 'distance_m', 'id', 'latitude',
      'longitude', 'name', 'phone', 'promo_text', 'website']);
  });

  test('nearby: the radius is clamped to 50 m and 20 km', async () => {
    await addMember('Close', 30);
    await addMember('Distant', 15000);
    await addMember('Too far', 25000);
    const tiny = await call(null, 'GET', `/members/nearby?lat=${HERE.lat}&lng=${HERE.lng}&radius_m=1`);
    assert.deepEqual(tiny.body.data.members.map((m) => m.name), [`Close ${stamp}`]);
    const huge = await call(null, 'GET', `/members/nearby?lat=${HERE.lat}&lng=${HERE.lng}&radius_m=999999`);
    const names = huge.body.data.members.map((m) => m.name);
    assert.ok(names.includes(`Distant ${stamp}`));
    assert.ok(!names.includes(`Too far ${stamp}`));
  });

  test('tiers: active tiers with numeric fees, null for the unset fee and the open top', async () => {
    const res = await call(null, 'GET', '/members/tiers');
    assert.equal(res.status, 200);
    const seeded = res.body.data.tiers.filter((t) => !t.name.endsWith(String(stamp)));
    assert.deepEqual(seeded.map((t) => [t.name, t.min_employees, t.max_employees, t.annual_fee, t.is_provisional]),
      [['Micro', 1, 5, 20, false], ['Small', 6, 20, 40, false], ['Medium', 21, 50, 75, false], ['Corporate', 51, null, 125, false]]);
  });

  test('apply, invoice, settings, then activate: the business appears on the map', async () => {
    let res = await call('boss', 'PUT', '/admin/membership-settings', { payment_instructions: `Bank transfer ${stamp}`, contact_email: '' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.settings.contact_email, null);

    res = await call(null, 'POST', '/members/apply', {
      ...POLICY, business_name: `Applied ${stamp}`, contact_name: 'Asha Brown', email: `asha-${stamp}@members.test`,
      employee_count: 250, category: 'hotel', latitude: north(500), longitude: HERE.lng,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.tier, { name: 'Corporate', annual_fee: 125, currency: 'USD', is_provisional: false });
    assert.equal(res.body.data.payment_instructions, `Bank transfer ${stamp}`);
    const id = res.body.data.application_id;
    const stored = (await q('SELECT status, quoted_fee, employee_count FROM membership_applications WHERE id = $1', [id])).rows[0];
    assert.deepEqual(stored, { status: 'new', quoted_fee: '125.00', employee_count: 250 });

    res = await call('boss', 'GET', '/admin/membership-applications?status=new');
    assert.equal(res.status, 200);
    const listed = res.body.data.applications.find((a) => a.id === id);
    assert.equal(listed.tier_name, 'Corporate');
    assert.equal(listed.quoted_fee, 125);
    assert.ok(res.body.data.summary.new >= 1);

    res = await call('boss', 'PATCH', `/admin/membership-applications/${id}`, { status: 'invoiced', admin_notes: 'Invoice 001 sent' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.application.status, 'invoiced');

    res = await call('boss', 'POST', `/admin/membership-applications/${id}/activate`, {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const business = res.body.data.business;
    assert.equal(business.membership_status, 'active');
    assert.equal(business.tier_name, 'Corporate');
    assert.equal(business.contact_email, `asha-${stamp}@members.test`);
    const months = (new Date(business.membership_expires_at) - Date.now()) / (24 * 60 * 60 * 1000);
    assert.ok(months > 364 && months < 367, `${months} days`);
    assert.equal(res.body.data.application.status, 'paid');
    assert.equal(res.body.data.application.business_id, business.id);

    const near = await call(null, 'GET', `/members/nearby?lat=${HERE.lat}&lng=${HERE.lng}`);
    assert.ok(near.body.data.members.some((m) => m.id === business.id));

    // Renewing links the same business; no second one is made.
    res = await call('boss', 'POST', `/admin/membership-applications/${id}/activate`, { months: 1 });
    assert.equal(res.status, 200);
    assert.equal(res.body.message, 'Membership renewed');
    assert.equal(res.body.data.business.id, business.id);
    // Renewed early: the month is added to the paid year, not to today.
    const renewed = new Date(res.body.data.business.membership_expires_at);
    const expected = new Date(business.membership_expires_at);
    expected.setUTCMonth(expected.getUTCMonth() + 1);
    assert.ok(Math.abs(renewed - expected) < 2 * 24 * 60 * 60 * 1000, `${renewed.toISOString()} vs ${expected.toISOString()}`);

    // After the membership has run out, a renewal counts from now.
    await q(`UPDATE businesses SET membership_expires_at = NOW() - INTERVAL '10 days' WHERE id = $1`, [business.id]);
    res = await call('boss', 'POST', `/admin/membership-applications/${id}/activate`, { months: 1 });
    const fromNow = (new Date(res.body.data.business.membership_expires_at) - Date.now()) / (24 * 60 * 60 * 1000);
    assert.ok(fromNow > 27 && fromNow < 32, `${fromNow} days`);
    assert.equal((await q('SELECT COUNT(*)::int AS n FROM businesses WHERE name = $1', [`Applied ${stamp}`])).rows[0].n, 1);
  });

  test('apply with a fee not set yet quotes null; activate without any location is refused', async () => {
    // The final tiers all have fees, so a tier with no fee yet is added for
    // this test, ahead of Corporate by sort_order for its own range.
    await q(`INSERT INTO membership_tiers (name, min_employees, max_employees, annual_fee, sort_order)
             VALUES ($1, 700000, 700010, NULL, 0)`, [`No fee tier ${stamp}`]);
    let res = await call(null, 'POST', '/members/apply', {
      ...POLICY, business_name: `No fee ${stamp}`, contact_name: 'Ben', email: `ben-${stamp}@members.test`, employee_count: 700005,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.tier.annual_fee, null);
    const id = res.body.data.application_id;
    res = await call('boss', 'POST', `/admin/membership-applications/${id}/activate`, {});
    assert.equal(res.status, 400);
    assert.equal((await q('SELECT status FROM membership_applications WHERE id = $1', [id])).rows[0].status, 'new', 'rolled back');
    res = await call('boss', 'POST', `/admin/membership-applications/${require('node:crypto').randomUUID()}/activate`, {});
    assert.equal(res.status, 404);
  });

  test('admin businesses: add with every new column, edit the promotion, clear it, expire the member', async () => {
    let res = await call('boss', 'POST', '/admin/businesses', {
      name: `Admin added ${stamp}`, latitude: north(50), longitude: HERE.lng, category: 'bar', tier_id: 1,
      employee_count: 5, contact_email: 'owner@bar.test', membership_status: 'active',
      membership_expires_at: new Date(Date.now() + 86400000).toISOString(), promo_text: 'Happy hour',
      membership_tier: 'legacy', business_size: 'small',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const b = res.body.data.business;
    assert.equal(b.tier_name, 'Micro');
    assert.equal(typeof b.latitude, 'number');
    assert.equal(b.created_by, users.boss);

    const near = async () => (await call(null, 'GET', `/members/nearby?lat=${HERE.lat}&lng=${HERE.lng}`)).body.data.members.find((m) => m.id === b.id);
    assert.equal((await near()).promo_text, 'Happy hour');

    res = await call('boss', 'PATCH', `/admin/businesses/${b.id}`, { promo_text: 'Two for one', promo_expires_at: new Date(Date.now() - 1000).toISOString() });
    assert.equal(res.status, 200);
    assert.equal((await near()).promo_text, null, 'promotion past its expiry');

    res = await call('boss', 'PATCH', `/admin/businesses/${b.id}`, { promo_text: null, promo_expires_at: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.business.promo_text, null);

    res = await call('boss', 'PATCH', `/admin/businesses/${b.id}`, { membership_status: 'expired' });
    assert.equal(res.status, 200);
    assert.equal(await near(), undefined, 'an expired member is not shown');

    res = await call('boss', 'GET', '/admin/businesses?membership_status=expired');
    assert.ok(res.body.data.businesses.some((x) => x.id === b.id));

    res = await call('boss', 'PATCH', `/admin/businesses/${b.id}`, { tier_id: 999999 });
    assert.equal(res.status, 400);
  });

  test('admin tiers: add an open-ended tier with no fee, edit it, and refuse max below min', async () => {
    let res = await call('boss', 'POST', '/admin/membership-tiers', {
      name: `Test tier ${stamp}`, min_employees: 500000, max_employees: null, annual_fee: null, sort_order: 99, is_active: false,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const tier = res.body.data.tier;
    assert.deepEqual([tier.max_employees, tier.annual_fee, tier.is_provisional, tier.currency], [null, null, false, 'USD']);

    res = await call('boss', 'PATCH', `/admin/membership-tiers/${tier.id}`, { annual_fee: 250.5, is_provisional: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.tier.annual_fee, 250.5);

    res = await call('boss', 'PATCH', `/admin/membership-tiers/${tier.id}`, { max_employees: 10 });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, 'Maximum employees must be at least the minimum');

    res = await call(null, 'GET', '/members/tiers');
    assert.ok(!res.body.data.tiers.some((t) => t.id === tier.id), 'an inactive tier is not public');
    res = await call('boss', 'GET', '/admin/membership-tiers');
    assert.ok(res.body.data.tiers.some((t) => t.id === tier.id));

    res = await call('boss', 'PATCH', '/admin/membership-tiers/999999', { name: 'x' });
    assert.equal(res.status, 404);
  });

  test('activate copies a 40-character phone; a rejected application is refused until reopened', async () => {
    let res = await call(null, 'POST', '/members/apply', {
      ...POLICY, business_name: `Long phone ${stamp}`, contact_name: 'Cy', email: `cy-${stamp}@members.test`, employee_count: 3,
      // 40 characters: the most the form takes, more than businesses.phone held.
      phone: '+1 876 555 0100 0101 0102 0103 0104 0105', latitude: north(700), longitude: HERE.lng,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const id = res.body.data.application_id;
    const stored = (await q('SELECT phone FROM membership_applications WHERE id = $1', [id])).rows[0].phone;
    assert.ok(stored.length > 30, `${stored.length} characters`);

    res = await call('boss', 'PATCH', `/admin/membership-applications/${id}`, { status: 'rejected' });
    assert.equal(res.status, 200);
    res = await call('boss', 'POST', `/admin/membership-applications/${id}/activate`, {});
    assert.equal(res.status, 409);
    assert.equal(res.body.message, 'This application was rejected. Reopen it before activating the membership.');
    assert.equal((await q('SELECT status, business_id FROM membership_applications WHERE id = $1', [id])).rows[0].business_id, null);

    res = await call('boss', 'PATCH', `/admin/membership-applications/${id}`, { status: 'new' });
    res = await call('boss', 'POST', `/admin/membership-applications/${id}/activate`, {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.business.phone, stored);
  });

  test('migration 027: the policy details are stored, copied to the listing, and a suspension hides it until lifted', async () => {
    const columns = async (table) => (await q(
      'SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table])).rows.map((r) => r.column_name);
    const appColumns = await columns('membership_applications');
    for (const c of ['trading_name', 'description', 'business_email', 'contact_position', 'contact_phone', 'terms_accepted_at']) {
      assert.ok(appColumns.includes(c), c);
    }
    const businessColumns = await columns('businesses');
    for (const c of ['registered_name', 'business_email', 'contact_name', 'contact_position', 'contact_phone']) {
      assert.ok(businessColumns.includes(c), c);
    }
    // migrate ran twice in before(): the check was replaced once and allows suspended.
    const checks = (await q(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
                              WHERE conrelid = 'businesses'::regclass AND conname = 'businesses_membership_status_check'`)).rows;
    assert.equal(checks.length, 1);
    assert.match(checks[0].def, /suspended/);

    const sentAt = Date.now();
    let res = await call(null, 'POST', '/members/apply', {
      ...POLICY, business_name: 'Island Grill Ltd', trading_name: `Island Grill ${stamp}`, description: 'Jerk by the sea',
      business_email: `hello-${stamp}@members.test`, website: 'https://facebook.com/islandgrill',
      contact_name: 'Dee', email: `dee-${stamp}@members.test`, employee_count: 4, latitude: north(300), longitude: HERE.lng,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.tier.name, 'Micro');
    const id = res.body.data.application_id;
    const stored = (await q('SELECT * FROM membership_applications WHERE id = $1', [id])).rows[0];
    assert.equal(stored.trading_name, `Island Grill ${stamp}`);
    assert.equal(stored.contact_position, 'Owner');
    assert.equal(stored.contact_phone, '876-555-0199');
    assert.ok(stored.terms_accepted_at instanceof Date);
    assert.ok(Math.abs(stored.terms_accepted_at - sentAt) < 60000, 'accepted when sent');

    res = await call('boss', 'GET', '/admin/membership-applications');
    assert.equal(res.body.data.applications.find((a) => a.id === id).business_status, null, 'no listing yet');

    res = await call('boss', 'POST', `/admin/membership-applications/${id}/activate`, {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const b = res.body.data.business;
    assert.equal(b.name, `Island Grill ${stamp}`, 'shown under the trading name');
    assert.equal(b.registered_name, 'Island Grill Ltd');
    assert.deepEqual(
      [b.description, b.business_email, b.contact_name, b.contact_position, b.contact_phone, b.phone],
      ['Jerk by the sea', `hello-${stamp}@members.test`, 'Dee', 'Owner', '876-555-0199', '876-555-0100'],
    );
    assert.equal(res.body.data.application.business_status, 'active');

    const shown = async () => (await call(null, 'GET', `/members/nearby?lat=${HERE.lat}&lng=${HERE.lng}`))
      .body.data.members.find((m) => m.id === b.id);
    const member = await shown();
    assert.ok(member, 'active: shown');
    for (const hidden of ['registered_name', 'business_email', 'contact_name', 'contact_position', 'contact_phone']) {
      assert.ok(!(hidden in member), `${hidden} is not sent to the app`);
    }

    res = await call('boss', 'PATCH', `/admin/businesses/${b.id}`, { membership_status: 'suspended' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.business.membership_expires_at, b.membership_expires_at, 'the expiry is left alone');
    assert.equal(await shown(), undefined, 'suspended: not shown');
    res = await call('boss', 'GET', '/admin/businesses?membership_status=suspended');
    assert.ok(res.body.data.businesses.some((x) => x.id === b.id));

    res = await call('boss', 'POST', `/admin/membership-applications/${id}/activate`, { months: 12 });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /suspended/);
    const still = (await q('SELECT membership_status, membership_expires_at FROM businesses WHERE id = $1', [b.id])).rows[0];
    assert.equal(still.membership_status, 'suspended');
    assert.equal(still.membership_expires_at.toISOString(), new Date(b.membership_expires_at).toISOString(), 'no time added');

    res = await call('boss', 'PATCH', `/admin/businesses/${b.id}`, { membership_status: 'active' });
    assert.equal(res.status, 200);
    assert.ok(await shown(), 'suspension lifted: shown again');
    res = await call('boss', 'POST', `/admin/membership-applications/${id}/activate`, { months: 1 });
    assert.equal(res.status, 200);
    assert.equal(res.body.message, 'Membership renewed');

    res = await call('boss', 'PATCH', `/admin/businesses/${b.id}`, { business_email: 'not-an-email' });
    assert.equal(res.status, 422);
    res = await call('boss', 'PATCH', `/admin/businesses/${b.id}`, { contact_position: '', registered_name: 'Island Grill Limited' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.business.contact_position, null, 'empty clears it');
    assert.equal(res.body.data.business.registered_name, 'Island Grill Limited');
  });

  test('nearby finds members across the antimeridian and next to the pole', async () => {
    const insert = (name, lat, lng) => q(
      `INSERT INTO businesses (name, latitude, longitude, membership_status, is_active) VALUES ($1, $2, $3, 'active', TRUE) RETURNING id`,
      [`${name} ${stamp}`, lat, lng]
    );
    // About 1 km apart, on either side of 180 degrees.
    const east = (await insert('Date line east', 17.2, 179.995)).rows[0].id;
    let res = await call(null, 'GET', '/members/nearby?lat=17.2&lng=-179.995');
    assert.equal(res.status, 200);
    const found = res.body.data.members.find((m) => m.id === east);
    assert.ok(found, 'found across the line');
    assert.ok(found.distance_m > 900 && found.distance_m < 1200, `${found.distance_m} m`);

    // 0.01 degrees from the pole, 120 degrees of longitude away: about 1.9 km.
    const polar = (await insert('Polar', 89.99, 0)).rows[0].id;
    res = await call(null, 'GET', '/members/nearby?lat=89.99&lng=120&radius_m=5000');
    const near = res.body.data.members.find((m) => m.id === polar);
    assert.ok(near, 'found near the pole');
    assert.ok(near.distance_m > 1700 && near.distance_m < 2100, `${near.distance_m} m`);
  });

  test('a website that is not http or https is refused on apply and on admin edits; a filled hidden field stores nothing', async () => {
    let res = await call(null, 'POST', '/members/apply', {
      ...POLICY, business_name: `Bot ${stamp}`, contact_name: 'Bot', email: `bot-${stamp}@members.test`, employee_count: 3, cw_hp: 'gotcha',
    });
    assert.equal(res.status, 201);
    assert.equal((await q('SELECT COUNT(*)::int AS n FROM membership_applications WHERE email = $1', [`bot-${stamp}@members.test`])).rows[0].n, 0);

    const b = (await q(`INSERT INTO businesses (name, latitude, longitude) VALUES ($1, 18, -76.8) RETURNING id`, [`Site ${stamp}`])).rows[0].id;
    res = await call('boss', 'PATCH', `/admin/businesses/${b}`, { website: 'javascript:alert(document.cookie)' });
    assert.equal(res.status, 422);
    res = await call('boss', 'PATCH', `/admin/businesses/${b}`, { website: 'www.grill.example' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.business.website, 'www.grill.example');
    res = await call('boss', 'PATCH', `/admin/businesses/${b}`, { website: '' });
    assert.equal(res.body.data.business.website, null, 'empty clears it');
  });

  test('the dashboard counts only members the app shows', async () => {
    const count = async () => (await call('boss', 'GET', '/admin/dashboard')).body.data.active_businesses;
    const before = await count();
    await addMember('Dash shown', 10000);
    await addMember('Dash expired', 10000, { expires: new Date(Date.now() - 1000) });
    await addMember('Dash pending', 10000, { status: 'pending' });
    await addMember('Dash unlisted', 10000, { is_active: false });
    assert.equal(await count(), before + 1);
  });

  test('a signed-in non-admin cannot reach the admin member endpoints', async () => {
    assert.equal((await call('ann', 'GET', '/admin/membership-applications')).status, 403);
    assert.equal((await call('ann', 'PUT', '/admin/membership-settings', { payment_instructions: 'x' })).status, 403);
  });
});
