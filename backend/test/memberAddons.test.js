// Version 1 membership add-ons (migration 034, docs/members-contract.md):
// featured placement, promotional and seasonal campaigns, and the renewal
// reminders list with its Send reminder button.
//
// The unit tests use fakes and always run. The tests at the end run the real
// migrations, routes and SQL against Postgres, and only when TEST_DATABASE_URL
// points at a throwaway database (they create and delete rows).

const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const membership = require('../src/services/membership');
const { buildMemberAdminHandlers, CAMPAIGN_MAX_DAYS } = require('../src/controllers/memberAdminController');

const SESSION_ID = '0b9c8d7e-6f5a-4b3c-8d2e-1f0a9b8c7d6e';
const USER_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const ADMIN_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const BUSINESS_ID = '77777777-6666-4555-8444-333333333333';
const OTHER_BUSINESS_ID = '88888888-6666-4555-8444-333333333333';
const CAMPAIGN_ID = '11111111-2222-4333-8444-555555555555';

const src = (mod) => require.resolve(path.join(__dirname, '../src', mod));

// 12:00 in Jamaica (UTC-5) on 18 November 2026.
const NOON = new Date('2026-11-18T17:00:00Z');
const TODAY = '2026-11-18';

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

const listen = async (app) => {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
};

const close = (server) => new Promise((resolve) => server.close(resolve));

const pgError = (code, constraint) => Object.assign(new Error('refused'), { code, constraint });

describe('the Jamaica calendar day', () => {
  test('the day turns at midnight in Jamaica (05:00 UTC), not at midnight UTC', () => {
    assert.equal(membership.jamaicaDay(new Date('2026-11-19T04:59:59Z')), '2026-11-18');
    assert.equal(membership.jamaicaDay(new Date('2026-11-19T05:00:00Z')), '2026-11-19');
    assert.equal(membership.jamaicaDay(new Date('2026-11-19T00:30:00Z')), '2026-11-18', 'already the 19th in UTC');
  });

  test('Jamaica keeps UTC-5 in July too (no daylight saving)', () => {
    assert.equal(membership.jamaicaDay(new Date('2026-07-01T04:59:00Z')), '2026-06-30');
    assert.equal(membership.jamaicaDay(new Date('2026-07-01T05:00:00Z')), '2026-07-01');
  });

  test('only real YYYY-MM-DD days are calendar days', () => {
    for (const ok of ['2026-11-18', '2028-02-29', '2026-12-31']) assert.equal(membership.isCalendarDay(ok), true, ok);
    for (const bad of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-1-1', '2026-11-18T00:00:00Z', '', null, 20261118, '18/11/2026']) {
      assert.equal(membership.isCalendarDay(bad), false, String(bad));
    }
  });

  test('a DATE column read by pg (local midnight) or as text comes back as the same day', () => {
    assert.equal(membership.calendarDate(new Date(2026, 11, 31)), '2026-12-31');
    assert.equal(membership.calendarDate('2026-12-31'), '2026-12-31');
    assert.equal(membership.calendarDate(null), null);
    assert.equal(membership.calendarDate('soon'), null);
    assert.equal(membership.calendarDate(new Date('nope')), null);
  });

  test('adding days crosses months and years; days between can be negative', () => {
    assert.equal(membership.addDays('2026-12-25', 7), '2027-01-01');
    assert.equal(membership.addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(membership.addDays('2026-11-18', -1), '2026-11-17');
    assert.equal(membership.daysBetween('2026-11-18', '2026-12-18'), 30);
    assert.equal(membership.daysBetween('2026-11-18', '2026-11-13'), -5);
    assert.equal(membership.daysBetween('2026-11-18', '2026-11-18'), 0);
  });
});

describe('featured placement', () => {
  test('featured through the end day, inclusive, and normal the day after', () => {
    const business = { is_featured: true, featured_until: '2026-11-18' };
    assert.equal(membership.isFeaturedOn(business, '2026-11-17'), true);
    assert.equal(membership.isFeaturedOn(business, '2026-11-18'), true, 'the end day itself');
    assert.equal(membership.isFeaturedOn(business, '2026-11-19'), false, 'expired featured is normal');
  });

  test('not featured when unticked, without an end date, or with no business', () => {
    assert.equal(membership.isFeaturedOn({ is_featured: false, featured_until: '2099-01-01' }, TODAY), false);
    assert.equal(membership.isFeaturedOn({ is_featured: true, featured_until: null }, TODAY), false);
    assert.equal(membership.isFeaturedOn(null, TODAY), false);
  });

  test('the app is told featured only when the server worked it out as true', () => {
    const row = { id: BUSINESS_ID, name: 'Grill', latitude: '18', longitude: '-76', distance_m: 10 };
    assert.equal(membership.publicMember({ ...row, featured_now: true }).featured, true);
    assert.equal(membership.publicMember({ ...row, featured_now: false }).featured, false);
    assert.equal(membership.publicMember({ ...row, featured_now: null }).featured, false);
    assert.equal(membership.publicMember(row).featured, false);
  });

  test('the admin panel gets featured_until as YYYY-MM-DD, also from a pg Date', () => {
    assert.equal(membership.adminBusiness({ featured_until: new Date(2027, 0, 5), latitude: '1', longitude: '2' }).featured_until, '2027-01-05');
    assert.equal(membership.adminBusiness({ featured_until: null, latitude: '1', longitude: '2' }).featured_until, null);
    assert.equal('featured_until' in membership.adminBusiness({ latitude: '1', longitude: '2' }), false);
  });
});

describe('campaigns', () => {
  const campaign = (extra) => ({
    id: CAMPAIGN_ID, business_id: BUSINESS_ID, kind: 'promotional', offer_text: 'Free coffee',
    start_date: '2026-11-18', end_date: '2026-11-24', ended_at: null, created_at: '2026-11-01T00:00:00Z', ...extra,
  });

  test('a campaign runs from its start day to its end day, both inclusive', () => {
    const c = campaign();
    assert.equal(membership.campaignState(c, '2026-11-17'), 'scheduled');
    assert.equal(membership.campaignState(c, '2026-11-18'), 'running', 'the start day');
    assert.equal(membership.campaignState(c, '2026-11-24'), 'running', 'the end day');
    assert.equal(membership.campaignState(c, '2026-11-25'), 'finished');
  });

  test('a one-day campaign runs on that day only; an ended one never runs', () => {
    const oneDay = campaign({ start_date: TODAY, end_date: TODAY });
    assert.equal(membership.campaignState(oneDay, TODAY), 'running');
    assert.equal(membership.campaignState(campaign({ ended_at: '2026-11-18T12:00:00Z' }), TODAY), 'ended');
  });

  test('overlapping campaigns: the one that started latest is used', () => {
    const long = campaign({ id: 'a', start_date: '2026-11-01', end_date: '2026-12-31', offer_text: 'Long' });
    const seasonal = campaign({ id: 'b', kind: 'seasonal', start_date: '2026-11-15', end_date: '2026-11-20', offer_text: 'Season' });
    assert.equal(membership.pickCampaign([long, seasonal], TODAY).offer_text, 'Season');
    assert.equal(membership.pickCampaign([seasonal, long], TODAY).offer_text, 'Season', 'whatever the order given');
    assert.equal(membership.pickCampaign([long, seasonal], '2026-11-21').offer_text, 'Long', 'back to the long one after');
  });

  test('same start day: the one entered latest wins, then the highest id', () => {
    const first = campaign({ id: 'a', created_at: '2026-11-01T00:00:00Z', offer_text: 'First' });
    const second = campaign({ id: 'b', created_at: '2026-11-02T00:00:00Z', offer_text: 'Second' });
    assert.equal(membership.pickCampaign([second, first], TODAY).offer_text, 'Second');
    const twinA = campaign({ id: 'a', offer_text: 'A' });
    const twinB = campaign({ id: 'b', offer_text: 'B' });
    assert.equal(membership.pickCampaign([twinA, twinB], TODAY).offer_text, 'B');
  });

  test('no running campaign: none is picked', () => {
    assert.equal(membership.pickCampaign([campaign({ ended_at: '2026-11-18T00:00:00Z' })], TODAY), null);
    assert.equal(membership.pickCampaign([], TODAY), null);
    assert.equal(membership.pickCampaign(undefined, TODAY), null);
  });

  test('the offer spoken is the campaign offer, else the promotion under its expiry', () => {
    const now = new Date('2026-11-18T12:00:00Z');
    assert.equal(membership.currentOffer({ campaign_offer: ' Season deal ', promo_text: 'Always 5% off' }, now), 'Season deal');
    assert.equal(membership.currentOffer({ campaign_offer: null, promo_text: 'Always 5% off' }, now), 'Always 5% off');
    assert.equal(membership.currentOffer({ campaign_offer: '   ', promo_text: 'Always 5% off' }, now), 'Always 5% off');
    assert.equal(membership.currentOffer({ campaign_offer: null, promo_text: 'Old', promo_expires_at: '2026-11-01T00:00:00Z' }, now), null);
    assert.equal(membership.currentOffer({}, now), null);
  });

  test('a campaign for the admin panel says where it stands and whether the app uses it', () => {
    const shaped = membership.adminCampaign(campaign({ start_date: new Date(2026, 10, 18), business_name: 'Grill' }), TODAY, true);
    assert.equal(shaped.start_date, '2026-11-18');
    assert.equal(shaped.state, 'running');
    assert.equal(shaped.in_use, true);
    assert.equal(shaped.business_name, 'Grill');
  });
});

describe('renewal reminder entries', () => {
  test('the representative email is used, else the business email, else none', () => {
    assert.equal(membership.reminderRecipient({ contact_email: ' rep@grill.test ', business_email: 'biz@grill.test' }), 'rep@grill.test');
    assert.equal(membership.reminderRecipient({ contact_email: '  ', business_email: 'biz@grill.test' }), 'biz@grill.test');
    assert.equal(membership.reminderRecipient({ contact_email: null, business_email: null }), null);
    assert.equal(membership.reminderRecipient(null), null);
  });

  test('days left counts Jamaica days; sent today is by the Jamaica day', () => {
    const entry = membership.renewalEntry({
      id: BUSINESS_ID, name: 'Grill', membership_status: 'active', contact_email: 'rep@grill.test',
      membership_expires_at: '2026-11-21T03:00:00Z', // 20 November, 22:00 in Jamaica
      last_reminder_sent_at: '2026-11-18T06:00:00Z', last_reminder_sent_by_name: 'Boss',
    }, NOON);
    assert.equal(entry.days_left, 2);
    assert.equal(entry.expired, false);
    assert.equal(entry.reminded_today, true);
    assert.equal(entry.recipient_email, 'rep@grill.test');
    assert.equal(entry.last_reminder_sent_by_name, 'Boss');

    const yesterday = membership.renewalEntry({
      id: BUSINESS_ID, name: 'Grill', membership_status: 'expired', membership_expires_at: '2026-11-13T17:00:00Z',
      last_reminder_sent_at: '2026-11-18T04:59:00Z', // 17 November in Jamaica
    }, NOON);
    assert.equal(yesterday.days_left, -5);
    assert.equal(yesterday.expired, true);
    assert.equal(yesterday.reminded_today, false);
    assert.equal(yesterday.recipient_email, null);
  });

  test('a membership that ends later today is not expired yet, and has 0 days left', () => {
    const entry = membership.renewalEntry({ id: BUSINESS_ID, name: 'Grill', membership_status: 'active', membership_expires_at: '2026-11-18T23:00:00Z' }, NOON);
    assert.equal(entry.days_left, 0);
    assert.equal(entry.expired, false);
    assert.equal(entry.reminded_today, false);
  });
});

describe('admin campaign handlers', () => {
  const ROW = {
    id: CAMPAIGN_ID, business_id: BUSINESS_ID, business_name: 'Grill', kind: 'promotional', offer_text: 'Free coffee',
    start_date: new Date(2026, 10, 18), end_date: new Date(2026, 10, 24), ended_at: null,
    created_at: new Date('2026-11-17T00:00:00Z'), updated_at: new Date('2026-11-17T00:00:00Z'),
  };

  const handlers = ({ calls = [], answer } = {}) => buildMemberAdminHandlers({
    query: async (text, params) => {
      calls.push({ text, params });
      if (answer) return answer(text, params);
      if (/^INSERT INTO member_campaigns/.test(text)) return { rows: [{ id: CAMPAIGN_ID }] };
      return { rows: [ROW] };
    },
    getClient: null,
    now: () => NOON,
  });

  const adding = (body) => ({
    user: { id: ADMIN_ID },
    body: { business_id: BUSINESS_ID, kind: 'promotional', offer_text: '  Free coffee  ', start_date: TODAY, end_date: '2026-11-24', ...body },
  });

  test('add: stores the offer trimmed, records the admin, answers 201 with dates as text', async () => {
    const calls = [];
    const res = makeRes();
    await handlers({ calls }).addCampaign(adding(), res);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(calls[0].params, [BUSINESS_ID, 'promotional', 'Free coffee', TODAY, '2026-11-24', ADMIN_ID]);
    assert.equal(res.body.data.campaign.start_date, '2026-11-18');
    assert.equal(res.body.data.campaign.end_date, '2026-11-24');
    assert.equal(res.body.data.campaign.state, 'running');
  });

  test('add: a campaign starting and ending today is accepted', async () => {
    const res = makeRes();
    await handlers().addCampaign(adding({ start_date: TODAY, end_date: TODAY }), res);
    assert.equal(res.statusCode, 201);
  });

  test('add: end before start, longer than the limit, or already over is a 400 before the database', async () => {
    for (const [body, message] of [
      [{ start_date: '2026-11-20', end_date: '2026-11-19' }, /on or after the start date/],
      [{ start_date: TODAY, end_date: membership.addDays(TODAY, CAMPAIGN_MAX_DAYS) }, /at most 366 days/],
      [{ start_date: '2026-11-01', end_date: '2026-11-17' }, /already be over/],
    ]) {
      const calls = [];
      const res = makeRes();
      await handlers({ calls }).addCampaign(adding(body), res);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.match(res.body.message, message);
      assert.equal(calls.length, 0);
    }
    const res = makeRes();
    await handlers().addCampaign(adding({ start_date: TODAY, end_date: membership.addDays(TODAY, CAMPAIGN_MAX_DAYS - 1) }), res);
    assert.equal(res.statusCode, 201, 'exactly the limit is allowed');
  });

  test('add: a business that does not exist is a 400, not a 500', async () => {
    const res = makeRes();
    await handlers({ answer: () => { throw pgError('23503', 'member_campaigns_business_fkey'); } }).addCampaign(adding(), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.message, 'That business does not exist');
  });

  test('add: a database failure is a 500, logged', async (t) => {
    const logged = silence(t);
    const res = makeRes();
    await handlers({ answer: () => { throw new Error('db down'); } }).addCampaign(adding(), res);
    assert.equal(res.statusCode, 500);
    assert.equal(logged.length, 1);
  });

  test('update: only the fields sent change, checked against the stored dates', async () => {
    const calls = [];
    const res = makeRes();
    await handlers({ calls }).updateCampaign({ params: { id: CAMPAIGN_ID }, body: { end_date: '2026-11-30', offer_text: ' New ' } }, res);
    assert.equal(res.statusCode, 200);
    const update = calls.find((c) => /^UPDATE member_campaigns/.test(c.text));
    assert.match(update.text, /SET offer_text = \$1, end_date = \$2, updated_at = NOW\(\) WHERE id = \$3/);
    assert.deepEqual(update.params, ['New', '2026-11-30', CAMPAIGN_ID]);
  });

  test('update: an end before the stored start is a 400, nothing written', async () => {
    const calls = [];
    const res = makeRes();
    await handlers({ calls }).updateCampaign({ params: { id: CAMPAIGN_ID }, body: { end_date: '2026-11-17' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(calls.some((c) => /^UPDATE/.test(c.text)), false);
  });

  test('update: nothing to change is 400; an unknown campaign 404', async () => {
    let res = makeRes();
    await handlers().updateCampaign({ params: { id: CAMPAIGN_ID }, body: { business_id: OTHER_BUSINESS_ID } }, res);
    assert.equal(res.statusCode, 400, 'the business cannot be changed');
    res = makeRes();
    await handlers({ answer: () => ({ rows: [] }) }).updateCampaign({ params: { id: CAMPAIGN_ID }, body: { kind: 'seasonal' } }, res);
    assert.equal(res.statusCode, 404);
  });

  test('end: stops a campaign once; again is a 409; unknown is a 404', async () => {
    let res = makeRes();
    await handlers().endCampaign({ params: { id: CAMPAIGN_ID } }, res);
    assert.equal(res.statusCode, 200);

    res = makeRes();
    await handlers({ answer: (text) => ({ rows: /^UPDATE/.test(text) ? [] : [ROW] }) }).endCampaign({ params: { id: CAMPAIGN_ID } }, res);
    assert.equal(res.statusCode, 409);

    res = makeRes();
    await handlers({ answer: () => ({ rows: [] }) }).endCampaign({ params: { id: CAMPAIGN_ID } }, res);
    assert.equal(res.statusCode, 404);
  });

  test('delete: 200, or 404 when there is no such campaign; a failure is a 500', async (t) => {
    let res = makeRes();
    await handlers().deleteCampaign({ params: { id: CAMPAIGN_ID } }, res);
    assert.equal(res.statusCode, 200);
    res = makeRes();
    await handlers({ answer: () => ({ rows: [] }) }).deleteCampaign({ params: { id: CAMPAIGN_ID } }, res);
    assert.equal(res.statusCode, 404);
    silence(t);
    res = makeRes();
    await handlers({ answer: () => { throw new Error('db down'); } }).deleteCampaign({ params: { id: CAMPAIGN_ID } }, res);
    assert.equal(res.statusCode, 500);
  });

  test('list: marks the campaign the app uses per business, and filters by state', async () => {
    const rows = [
      { ...ROW, id: 'c3', business_id: BUSINESS_ID, start_date: '2026-11-15', end_date: '2026-11-20' },
      { ...ROW, id: 'c2', business_id: BUSINESS_ID, start_date: '2026-11-01', end_date: '2026-12-31' },
      { ...ROW, id: 'c1', business_id: OTHER_BUSINESS_ID, start_date: '2026-10-01', end_date: '2026-10-31' },
      { ...ROW, id: 'c4', business_id: OTHER_BUSINESS_ID, start_date: '2026-12-01', end_date: '2026-12-07' },
    ];
    let res = makeRes();
    await handlers({ answer: () => ({ rows }) }).getCampaigns({ query: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.today, TODAY);
    const byId = Object.fromEntries(res.body.data.campaigns.map((c) => [c.id, c]));
    assert.equal(byId.c3.in_use, true);
    assert.equal(byId.c2.in_use, false, 'running, but the later start wins');
    assert.equal(byId.c1.state, 'finished');
    assert.equal(byId.c4.state, 'scheduled');

    res = makeRes();
    await handlers({ answer: () => ({ rows }) }).getCampaigns({ query: { state: 'running' } }, res);
    assert.deepEqual(res.body.data.campaigns.map((c) => c.id), ['c3', 'c2']);
  });

  test('list: filters by business in SQL', async () => {
    const calls = [];
    await handlers({ calls }).getCampaigns({ query: { business_id: BUSINESS_ID } }, makeRes());
    assert.match(calls[0].text, /c\.business_id = \$1/);
    assert.deepEqual(calls[0].params, [BUSINESS_ID]);
  });
});

describe('admin renewal reminder handlers', () => {
  const MEMBER = {
    id: BUSINESS_ID, name: 'Island Grill', membership_status: 'active', membership_expires_at: new Date('2026-12-01T05:00:00Z'),
    contact_email: 'rep@grill.test', business_email: null, last_reminder_sent_at: null,
  };

  /** A transaction client that answers by statement and records them. */
  const fakeClient = ({ business = MEMBER, settings = { payment_instructions: 'Bank: NCB 123', contact_email: 'info@caribwayz.test' }, failOn } = {}) => {
    const statements = [];
    let released = 0;
    return {
      statements,
      get released() { return released; },
      release: () => { released += 1; },
      query: async (text, params) => {
        statements.push({ text, params });
        if (failOn && failOn.test(text)) throw new Error('db down');
        if (/FROM businesses WHERE id = \$1 FOR UPDATE/.test(text)) return { rows: business ? [business] : [] };
        if (/FROM membership_settings/.test(text)) return { rows: settings ? [settings] : [] };
        return { rows: [] };
      },
    };
  };

  const reminder = ({ client, configured = true, send = async () => {}, adminEmail = 'ops@caribwayz.test', queryRows } = {}) => {
    const sent = [];
    const handlers = buildMemberAdminHandlers({
      query: async () => ({ rows: queryRows || [{ ...MEMBER, last_reminder_sent_at: NOON, last_reminder_sent_by_name: 'Boss' }] }),
      getClient: async () => client,
      now: () => NOON,
      isEmailConfigured: () => configured,
      sendRenewalReminder: async (args) => { sent.push(args); return send(args); },
      adminContactEmail: () => adminEmail,
    });
    return { handlers, sent };
  };

  const request = (body = {}) => ({ params: { id: BUSINESS_ID }, user: { id: ADMIN_ID }, body });

  test('sends to the representative, records when and by whom, and commits', async () => {
    const client = fakeClient();
    const { handlers, sent } = reminder({ client });
    const res = makeRes();
    await handlers.sendReminder(request(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'Reminder sent to rep@grill.test');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].toEmail, 'rep@grill.test');
    assert.equal(sent[0].businessName, 'Island Grill');
    assert.equal(sent[0].expired, false);
    assert.equal(sent[0].contactEmail, 'info@caribwayz.test');
    assert.equal(sent[0].paymentInstructions, 'Bank: NCB 123');
    const update = client.statements.find((s) => /^UPDATE businesses SET last_reminder_sent_at/.test(s.text));
    assert.deepEqual(update.params, [NOON, ADMIN_ID, BUSINESS_ID]);
    assert.equal(client.statements.at(-1).text, 'COMMIT');
    assert.equal(client.released, 1);
    assert.equal(res.body.data.renewal.reminded_today, true);
    assert.equal(res.body.data.renewal.last_reminder_sent_by_name, 'Boss');
  });

  test('an expired membership is told it ended; replies go to ADMIN_EMAIL when the settings have no contact', async () => {
    const client = fakeClient({
      business: { ...MEMBER, membership_status: 'expired', membership_expires_at: new Date('2026-11-10T05:00:00Z'), contact_email: null, business_email: 'biz@grill.test' },
      settings: null,
    });
    const { handlers, sent } = reminder({ client });
    const res = makeRes();
    await handlers.sendReminder(request(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(sent[0].toEmail, 'biz@grill.test');
    assert.equal(sent[0].expired, true);
    assert.equal(sent[0].contactEmail, 'ops@caribwayz.test');
    assert.equal(sent[0].paymentInstructions, '');
  });

  test('no SMTP login is a 503, and nothing is asked of the database', async () => {
    let asked = false;
    const handlers = buildMemberAdminHandlers({
      query: async () => { asked = true; return { rows: [] }; },
      getClient: async () => { asked = true; return fakeClient(); },
      isEmailConfigured: () => false,
      sendRenewalReminder: async () => { throw new Error('must not send'); },
    });
    const res = makeRes();
    await handlers.sendReminder(request(), res);
    assert.equal(res.statusCode, 503);
    assert.match(res.body.message, /SMTP/);
    assert.equal(asked, false);
  });

  test('a business with no contact or business email is a 400, rolled back, nothing sent', async () => {
    const client = fakeClient({ business: { ...MEMBER, contact_email: '', business_email: null } });
    const { handlers, sent } = reminder({ client });
    const res = makeRes();
    await handlers.sendReminder(request(), res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /no contact or business email/);
    assert.equal(sent.length, 0);
    assert.equal(client.statements.at(-1).text, 'ROLLBACK');
    assert.equal(client.released, 1);
  });

  test('unknown business 404; no end date 400; cancelled, pending or suspended 409', async () => {
    for (const [business, status] of [
      [null, 404],
      [{ ...MEMBER, membership_expires_at: null }, 400],
      [{ ...MEMBER, membership_status: 'cancelled' }, 409],
      [{ ...MEMBER, membership_status: 'pending' }, 409],
      [{ ...MEMBER, membership_status: 'suspended' }, 409],
    ]) {
      const client = fakeClient({ business });
      const { handlers, sent } = reminder({ client });
      const res = makeRes();
      await handlers.sendReminder(request(), res);
      assert.equal(res.statusCode, status, JSON.stringify(business));
      assert.equal(sent.length, 0);
      assert.equal(client.statements.at(-1).text, 'ROLLBACK');
      assert.equal(client.released, 1);
    }
  });

  test('a second reminder the same Jamaica day is a 409 unless resend is true', async () => {
    const sentEarlier = { ...MEMBER, last_reminder_sent_at: new Date('2026-11-18T05:30:00Z') };
    let client = fakeClient({ business: sentEarlier });
    let { handlers, sent } = reminder({ client });
    let res = makeRes();
    await handlers.sendReminder(request(), res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /already sent to this business today/);
    assert.equal(sent.length, 0);

    client = fakeClient({ business: sentEarlier });
    ({ handlers, sent } = reminder({ client }));
    res = makeRes();
    await handlers.sendReminder(request({ resend: true }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(sent.length, 1);

    // Sent at 23:30 yesterday in Jamaica (04:30 UTC today): a new day.
    client = fakeClient({ business: { ...MEMBER, last_reminder_sent_at: new Date('2026-11-18T04:30:00Z') } });
    ({ handlers, sent } = reminder({ client }));
    res = makeRes();
    await handlers.sendReminder(request(), res);
    assert.equal(res.statusCode, 200);
  });

  test('a mail server failure is a 502, rolled back, nothing recorded, no address logged', async (t) => {
    const logged = silence(t);
    const client = fakeClient();
    const { handlers } = reminder({ client, send: async () => { throw new Error('connect ECONNREFUSED'); } });
    const res = makeRes();
    await handlers.sendReminder(request(), res);
    assert.equal(res.statusCode, 502);
    assert.equal(client.statements.some((s) => /^UPDATE businesses/.test(s.text)), false);
    assert.equal(client.statements.at(-1).text, 'ROLLBACK');
    assert.equal(client.released, 1);
    assert.ok(logged.some((l) => /ECONNREFUSED/.test(l)));
    assert.ok(logged.every((l) => !/rep@grill\.test/.test(l)));
  });

  test('a database failure part way is a 500, rolled back, the client released', async (t) => {
    silence(t);
    const client = fakeClient({ failOn: /^UPDATE businesses/ });
    const { handlers } = reminder({ client });
    const res = makeRes();
    await handlers.sendReminder(request(), res);
    assert.equal(res.statusCode, 500);
    assert.equal(client.statements.at(-1).text, 'ROLLBACK');
    assert.equal(client.released, 1);
  });

  test('no database connection is a 500', async (t) => {
    silence(t);
    const handlers = buildMemberAdminHandlers({
      query: async () => ({ rows: [] }),
      getClient: async () => { throw new Error('pool exhausted'); },
      isEmailConfigured: () => true,
      sendRenewalReminder: async () => {},
    });
    const res = makeRes();
    await handlers.sendReminder(request(), res);
    assert.equal(res.statusCode, 500);
  });

  test('the list splits ending soon (soonest first) from recently expired (latest first)', async () => {
    const rows = [
      { id: 'e2', name: 'Ended 20 days ago', membership_status: 'expired', membership_expires_at: new Date('2026-10-29T17:00:00Z') },
      { id: 'e1', name: 'Ended 2 days ago', membership_status: 'active', membership_expires_at: new Date('2026-11-16T17:00:00Z') },
      { id: 's1', name: 'Ends in 3 days', membership_status: 'active', membership_expires_at: new Date('2026-11-21T17:00:00Z'), contact_email: 'a@b.test' },
      { id: 's2', name: 'Ends in 29 days', membership_status: 'active', membership_expires_at: new Date('2026-12-17T17:00:00Z') },
    ];
    const handlers = buildMemberAdminHandlers({
      query: async (text, params) => { assert.deepEqual(params, [30]); return { rows }; },
      getClient: null,
      now: () => NOON,
      isEmailConfigured: () => false,
    });
    const res = makeRes();
    await handlers.getRenewals({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.window_days, 30);
    assert.equal(res.body.data.email_configured, false);
    assert.deepEqual(res.body.data.ending_soon.map((e) => [e.id, e.days_left]), [['s1', 3], ['s2', 29]]);
    assert.deepEqual(res.body.data.recently_expired.map((e) => [e.id, e.days_left]), [['e1', -2], ['e2', -20]]);
    assert.equal(res.body.data.ending_soon[0].recipient_email, 'a@b.test');
  });

  test('the list: a database failure is a 500', async (t) => {
    silence(t);
    const handlers = buildMemberAdminHandlers({ query: async () => { throw new Error('db down'); }, getClient: null });
    const res = makeRes();
    await handlers.getRenewals({}, res);
    assert.equal(res.statusCode, 500);
  });
});

describe('the renewal reminder email', () => {
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

  const args = {
    toEmail: 'rep@grill.test', businessName: 'Grill <b>\r\nBcc: x@evil.test', expiresAt: new Date('2026-12-01T04:00:00Z'),
    expired: false, contactEmail: 'info@caribwayz.test', paymentInstructions: 'Bank <script>x</script>\nAccount 123',
  };

  test('says the Jamaica day it ends, escapes the name and instructions, one-line subject, reply-to the team', async (t) => {
    const sent = [];
    const { sendMembershipRenewalReminder } = loadMailer(t, async (mail) => { sent.push(mail); });
    await sendMembershipRenewalReminder(args);
    assert.equal(sent.length, 1);
    const [mail] = sent;
    assert.equal(mail.to, 'rep@grill.test');
    assert.equal(mail.replyTo, 'info@caribwayz.test');
    assert.doesNotMatch(mail.subject, /[\r\n]/);
    assert.match(mail.subject, /ends on 30 November 2026/, '04:00 UTC on 1 December is 30 November in Jamaica');
    assert.doesNotMatch(mail.html, /<script>|<b>/);
    assert.match(mail.html, /&lt;script&gt;/);
    assert.match(mail.text, /Account 123/);
    assert.match(mail.text, /write to info@caribwayz\.test/);
  });

  test('an ended membership says so; no contact and no instructions leave both out', async (t) => {
    const sent = [];
    const { sendMembershipRenewalReminder } = loadMailer(t, async (mail) => { sent.push(mail); });
    await sendMembershipRenewalReminder({ ...args, businessName: 'Grill', expired: true, contactEmail: null, paymentInstructions: '  ' });
    const [mail] = sent;
    assert.match(mail.subject, /ended on 30 November 2026/);
    assert.match(mail.text, /no longer shown on the CaribWayz map/);
    assert.equal('replyTo' in mail, false);
    assert.doesNotMatch(mail.text, /How to pay/);
  });

  test('refuses a bad recipient, no name or no date before sending', async (t) => {
    const sent = [];
    const { sendMembershipRenewalReminder } = loadMailer(t, async (mail) => { sent.push(mail); });
    for (const bad of [
      { toEmail: 'a@b.test\r\nBcc: c@d.test' }, { toEmail: 'a@b.test, c@d.test' }, { toEmail: 'nobody' },
      { businessName: ' ' }, { expiresAt: new Date('nope') }, { expiresAt: '2026-12-01' },
    ]) {
      await assert.rejects(sendMembershipRenewalReminder({ ...args, ...bad }), /sendMembershipRenewalReminder/, JSON.stringify(bad));
    }
    assert.equal(sent.length, 0);
  });

  test('a mail server failure is thrown to the caller', async (t) => {
    const { sendMembershipRenewalReminder } = loadMailer(t, async () => { throw new Error('535 auth failed'); });
    await assert.rejects(sendMembershipRenewalReminder(args), /535/);
  });
});

describe('admin add-on routes: access and validation', () => {
  let server;
  let base;
  let sessionCheck;
  let userToken;
  let adminToken;

  before(async () => {
    sessionCheck = mock.method(require('../src/services/sessionService').sessionService(), 'isSessionActive', async () => true);
    const { generateToken } = require('../src/utils/jwt');
    userToken = generateToken({ id: USER_ID, email: 'u@example.com', role: 'user', sid: SESSION_ID });
    adminToken = generateToken({ id: ADMIN_ID, email: 'a@example.com', role: 'admin', sid: SESSION_ID });
    const app = express();
    app.use(express.json());
    app.use('/admin', require('../src/routes/admin'));
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

  const ROUTES = [
    ['GET', '/admin/membership-campaigns'],
    ['POST', '/admin/membership-campaigns', { business_id: BUSINESS_ID, kind: 'promotional', offer_text: 'x', start_date: TODAY, end_date: TODAY }],
    ['PATCH', `/admin/membership-campaigns/${CAMPAIGN_ID}`, { offer_text: 'x' }],
    ['POST', `/admin/membership-campaigns/${CAMPAIGN_ID}/end`, {}],
    ['DELETE', `/admin/membership-campaigns/${CAMPAIGN_ID}`],
    ['GET', '/admin/membership-renewals'],
    ['POST', `/admin/membership-renewals/${BUSINESS_ID}/remind`, {}],
    ['PATCH', `/admin/businesses/${BUSINESS_ID}`, { is_featured: true, featured_until: TODAY }],
  ];

  test('every add-on endpoint needs a sign-in (401) and an admin (403)', async () => {
    for (const [method, url, body] of ROUTES) {
      assert.equal((await call(method, url, body)).status, 401, `${method} ${url} without a token`);
      assert.equal((await call(method, url, body, userToken)).status, 403, `${method} ${url} as a user`);
    }
  });

  test('bad input is refused before the database (422), naming the field', async () => {
    const good = { business_id: BUSINESS_ID, kind: 'seasonal', offer_text: 'Christmas: 10% off', start_date: '2026-12-01', end_date: '2026-12-31' };
    const cases = [
      ['POST', '/admin/membership-campaigns', { ...good, business_id: 'nope' }, 'business_id'],
      ['POST', '/admin/membership-campaigns', { ...good, kind: 'flash' }, 'kind'],
      ['POST', '/admin/membership-campaigns', { ...good, offer_text: '   ' }, 'offer_text'],
      ['POST', '/admin/membership-campaigns', { ...good, offer_text: 'x'.repeat(281) }, 'offer_text'],
      ['POST', '/admin/membership-campaigns', { ...good, offer_text: 5 }, 'offer_text'],
      ['POST', '/admin/membership-campaigns', { ...good, start_date: '2026-02-30' }, 'start_date'],
      ['POST', '/admin/membership-campaigns', { ...good, end_date: '2026-12-31T00:00:00Z' }, 'end_date'],
      ['POST', '/admin/membership-campaigns', { kind: 'seasonal', offer_text: 'x', start_date: TODAY, end_date: TODAY }, 'business_id'],
      ['PATCH', `/admin/membership-campaigns/${CAMPAIGN_ID}`, { end_date: null }, 'end_date'],
      ['PATCH', '/admin/membership-campaigns/not-a-uuid', { kind: 'seasonal' }, 'id'],
      ['POST', '/admin/membership-campaigns/not-a-uuid/end', {}, 'id'],
      ['DELETE', '/admin/membership-campaigns/not-a-uuid', undefined, 'id'],
      ['GET', '/admin/membership-campaigns?state=live', undefined, 'state'],
      ['GET', '/admin/membership-campaigns?business_id=1', undefined, 'business_id'],
      ['POST', '/admin/membership-renewals/not-a-uuid/remind', {}, 'id'],
      ['POST', `/admin/membership-renewals/${BUSINESS_ID}/remind`, { resend: 'yes' }, 'resend'],
      ['PATCH', `/admin/businesses/${BUSINESS_ID}`, { is_featured: 'yes' }, 'is_featured'],
      ['PATCH', `/admin/businesses/${BUSINESS_ID}`, { featured_until: '2026-11-31' }, 'featured_until'],
      ['PATCH', `/admin/businesses/${BUSINESS_ID}`, { is_featured: true, featured_until: null }, 'featured_until'],
      ['POST', '/admin/businesses', { name: 'X', latitude: 18, longitude: -76, is_featured: true }, 'featured_until'],
    ];
    for (const [method, url, body, field] of cases) {
      const res = await call(method, url, body, adminToken);
      assert.equal(res.status, 422, `${method} ${url} ${JSON.stringify(body)}`);
      assert.ok(res.body.errors.map((e) => e.path).includes(field), `${field} in ${JSON.stringify(res.body.errors)}`);
    }
  });
});

describe('member add-ons against Postgres', { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL to a throwaway database' }, () => {
  let server;
  let base;
  let pool;
  let emailService;
  let today;
  const stamp = Date.now();
  const users = {};
  const tokens = {};
  // A quiet spot off Jamaica's west coast, away from the other suites' rows.
  const HERE = { lat: 17.6, lng: -78.7 };
  const north = (metres) => HERE.lat + metres / 111195;
  const q = (text, params) => pool.query(text, params);

  const call = async (who, method, url, body) => {
    const headers = { 'content-type': 'application/json' };
    if (who) headers.authorization = `Bearer ${tokens[who]}`;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  const addMember = async (name, metres, extra = {}) => (await q(
    `INSERT INTO businesses (name, category, latitude, longitude, membership_status, membership_expires_at, is_active,
                             promo_text, is_featured, featured_until, contact_email, business_email)
     VALUES ($1, 'restaurant', $2, $3, $4, $5, TRUE, $6, $7, $8, $9, $10) RETURNING id`,
    [`${name} ${stamp}`, north(metres), HERE.lng, extra.status || 'active', extra.expires === undefined ? null : extra.expires,
     extra.promo || null, extra.featuredUntil !== undefined, extra.featuredUntil ?? null,
     extra.contact === undefined ? null : extra.contact, extra.businessEmail || null]
  )).rows[0].id;

  const addCampaign = (businessId, start, end, offer, extra = {}) => q(
    `INSERT INTO member_campaigns (business_id, kind, offer_text, start_date, end_date, ended_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW())) RETURNING id`,
    [businessId, extra.kind || 'promotional', offer, start, end, extra.endedAt || null, extra.createdAt || null]
  );

  const nearby = async () => {
    const res = await call(null, 'GET', `/members/nearby?lat=${HERE.lat}&lng=${HERE.lng}&radius_m=3000`);
    assert.equal(res.status, 200);
    return res.body.data.members.filter((m) => m.name.endsWith(` ${stamp}`));
  };

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
    today = (await q(`SELECT (NOW() AT TIME ZONE 'America/Jamaica')::date::text AS today`)).rows[0].today;

    for (const [key, role] of [['boss', 'admin'], ['ann', 'user']]) {
      users[key] = (await q(
        `INSERT INTO users (name, email, role, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
        [`Addons ${key}`, `${key}-${stamp}@addons.test`, role]
      )).rows[0].id;
    }
    const { generateToken } = require('../src/utils/jwt');
    for (const [k, id] of Object.entries(users)) {
      const sid = require('node:crypto').randomUUID();
      await q(`INSERT INTO user_sessions (id, user_id, method, platform, expires_at)
               VALUES ($1, $2, 'email', 'android', NOW() + INTERVAL '1 day')`, [sid, id]);
      tokens[k] = generateToken({ id, email: `${k}@addons.test`, role: k === 'boss' ? 'admin' : 'user', sid });
    }

    emailService = require('../src/services/emailService');
    const app = express();
    app.use(express.json());
    app.use('/members', require('../src/routes/members'));
    app.use('/admin', require('../src/routes/admin'));
    ({ server, base } = await listen(app));
  });

  after(async () => {
    if (server) await close(server);
    if (pool) {
      await q(`DELETE FROM businesses WHERE name LIKE $1`, [`% ${stamp}`]);
      await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [Object.values(users)]);
      await pool.end();
    }
    await require('../src/config/db').pool.end();
  });

  test('migration 034: the columns, the campaigns table, and its rules', async () => {
    const columns = (await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'businesses'`)).rows.map((r) => r.column_name);
    for (const c of ['is_featured', 'featured_until', 'last_reminder_sent_at', 'last_reminder_sent_by']) assert.ok(columns.includes(c), c);
    const id = await addMember('Rules', 2900);
    await assert.rejects(q('UPDATE businesses SET is_featured = TRUE, featured_until = NULL WHERE id = $1', [id]), /businesses_featured_until_check/);
    await assert.rejects(addCampaign(id, '2026-12-02', '2026-12-01', 'x'), /member_campaigns_dates_check/);
    await assert.rejects(addCampaign(id, '2026-12-01', '2026-12-01', '  '), /member_campaigns_offer_check/);
    await assert.rejects(addCampaign(id, '2026-12-01', '2026-12-01', 'x', { kind: 'flash' }), /member_campaigns_kind_check/);
    const constraints = (await q(`SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname = 'businesses_featured_until_check'`)).rows[0].n;
    assert.equal(constraints, 1, 'running the migration twice added the check once');
  });

  test('featured: listed first while featured; expired featured is normal; ends inclusive', async () => {
    await addMember('Plain near', 100);
    await addMember('Featured far', 2000, { featuredUntil: today });
    await addMember('Featured expired', 50, { featuredUntil: membership.addDays(today, -1) });
    const members = await nearby();
    assert.deepEqual(members.map((m) => m.name.replace(` ${stamp}`, '')).slice(0, 3), ['Featured far', 'Featured expired', 'Plain near']);
    assert.deepEqual(members.slice(0, 3).map((m) => m.featured), [true, false, false]);
  });

  test('featured: a member the app does not show is not featured in the admin list', async () => {
    const shown = await addMember('Admin featured', 2950, { featuredUntil: membership.addDays(today, 10) });
    const lapsed = await addMember('Admin lapsed member', 2950, { featuredUntil: membership.addDays(today, 10), expires: new Date(Date.now() - 1000) });
    const res = await call('boss', 'GET', '/admin/businesses');
    assert.equal(res.status, 200);
    const list = res.body.data.businesses;
    const row = (id) => list.find((b) => b.id === id);
    assert.equal(row(shown).featured_now, true);
    assert.equal(row(shown).featured_until, membership.addDays(today, 10));
    assert.equal(row(lapsed).featured_now, false);
    assert.equal(list[0].featured_now, true, 'featured members first');
  });

  test('featured: an admin ticks it with an end date, and unticks it', async () => {
    const id = await addMember('Tick', 2800);
    let res = await call('boss', 'PATCH', `/admin/businesses/${id}`, { is_featured: true, featured_until: membership.addDays(today, 365) });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.business.is_featured, true);
    assert.equal(res.body.data.business.featured_now, true);
    res = await call('boss', 'PATCH', `/admin/businesses/${id}`, { is_featured: false });
    assert.equal(res.body.data.business.featured_now, false);
    res = await call('boss', 'PATCH', `/admin/businesses/${id}`, { featured_until: null, is_featured: false });
    assert.equal(res.status, 200);
    res = await call('boss', 'PATCH', `/admin/businesses/${id}`, { is_featured: true });
    assert.equal(res.status, 400, 'ticked with no end date stored');
    assert.equal(res.body.message, 'Give the date the featured placement ends');
  });

  test('campaigns: spoken on the start day and the end day, not before or after; else the promotion', async () => {
    const starts = await addMember('Starts today', 300, { promo: 'Always 5% off' });
    await addCampaign(starts, today, membership.addDays(today, 6), 'Week deal');
    const ends = await addMember('Ends today', 310, { promo: 'Always 5% off' });
    await addCampaign(ends, membership.addDays(today, -13), today, 'Fortnight deal');
    const tomorrow = await addMember('Starts tomorrow', 320, { promo: 'Always 5% off' });
    await addCampaign(tomorrow, membership.addDays(today, 1), membership.addDays(today, 30), 'Not yet');
    const over = await addMember('Ended yesterday', 330);
    await addCampaign(over, membership.addDays(today, -7), membership.addDays(today, -1), 'Too late');

    const offers = Object.fromEntries((await nearby()).map((m) => [m.name.replace(` ${stamp}`, ''), m.promo_text]));
    assert.equal(offers['Starts today'], 'Week deal');
    assert.equal(offers['Ends today'], 'Fortnight deal');
    assert.equal(offers['Starts tomorrow'], 'Always 5% off');
    assert.equal(offers['Ended yesterday'], null);
  });

  test('campaigns: overlapping ones use the latest start; ending it early goes back to the other', async () => {
    const id = await addMember('Overlap', 400);
    await addCampaign(id, membership.addDays(today, -20), membership.addDays(today, 20), 'Long promotion');
    const seasonal = (await addCampaign(id, membership.addDays(today, -1), membership.addDays(today, 5), 'Season special', { kind: 'seasonal' })).rows[0].id;
    const offer = async () => (await nearby()).find((m) => m.id === id).promo_text;
    assert.equal(await offer(), 'Season special');

    const list = await call('boss', 'GET', `/admin/membership-campaigns?business_id=${id}`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.campaigns.map((c) => [c.offer_text, c.state, c.in_use]),
      [['Season special', 'running', true], ['Long promotion', 'running', false]]);

    const ended = await call('boss', 'POST', `/admin/membership-campaigns/${seasonal}/end`);
    assert.equal(ended.status, 200);
    assert.equal(ended.body.data.campaign.state, 'ended');
    assert.equal(await offer(), 'Long promotion');
    assert.equal((await call('boss', 'POST', `/admin/membership-campaigns/${seasonal}/end`)).status, 409);
  });

  test('campaigns: an admin adds, edits and deletes one; bad dates and unknown businesses are refused', async () => {
    const id = await addMember('Admin campaign', 500);
    let res = await call('boss', 'POST', '/admin/membership-campaigns', {
      business_id: id, kind: 'promotional', offer_text: ' 2 for 1 lunch ', start_date: today, end_date: membership.addDays(today, 13),
    });
    assert.equal(res.status, 201);
    const campaign = res.body.data.campaign;
    assert.equal(campaign.offer_text, '2 for 1 lunch');
    assert.equal(campaign.start_date, today);
    assert.equal(campaign.end_date, membership.addDays(today, 13));
    assert.equal(campaign.created_by_name, 'Addons boss');
    assert.equal(campaign.business_name, `Admin campaign ${stamp}`);

    res = await call('boss', 'PATCH', `/admin/membership-campaigns/${campaign.id}`, { kind: 'seasonal', end_date: membership.addDays(today, 29) });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.campaign.kind, 'seasonal');
    assert.equal(res.body.data.campaign.end_date, membership.addDays(today, 29));

    res = await call('boss', 'PATCH', `/admin/membership-campaigns/${campaign.id}`, { end_date: membership.addDays(today, -1) });
    assert.equal(res.status, 400, 'before the stored start');

    res = await call('boss', 'POST', '/admin/membership-campaigns', {
      business_id: '00000000-0000-4000-8000-000000000000', kind: 'promotional', offer_text: 'x', start_date: today, end_date: today,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, 'That business does not exist');

    res = await call('boss', 'DELETE', `/admin/membership-campaigns/${campaign.id}`);
    assert.equal(res.status, 200);
    assert.equal((await call('boss', 'DELETE', `/admin/membership-campaigns/${campaign.id}`)).status, 404);
    assert.equal((await nearby()).find((m) => m.id === id).promo_text, null);
  });

  test('renewals: ending within 30 days and ended within 30 days, apart; others left out', async () => {
    const day = 24 * 60 * 60 * 1000;
    const soon = await addMember('Renew soon', 2700, { expires: new Date(Date.now() + 10 * day), contact: 'rep@renew.test' });
    const lapsed = await addMember('Renew lapsed', 2700, { expires: new Date(Date.now() - 5 * day), status: 'expired' });
    const later = await addMember('Renew later', 2700, { expires: new Date(Date.now() + 40 * day) });
    const longAgo = await addMember('Renew long ago', 2700, { expires: new Date(Date.now() - 40 * day), status: 'expired' });
    const cancelled = await addMember('Renew cancelled', 2700, { expires: new Date(Date.now() + 3 * day), status: 'cancelled' });

    const res = await call('boss', 'GET', '/admin/membership-renewals');
    assert.equal(res.status, 200);
    const soonIds = res.body.data.ending_soon.map((e) => e.id);
    const lapsedIds = res.body.data.recently_expired.map((e) => e.id);
    assert.ok(soonIds.includes(soon));
    assert.ok(lapsedIds.includes(lapsed));
    for (const id of [later, longAgo, cancelled]) assert.ok(!soonIds.includes(id) && !lapsedIds.includes(id), id);
    const entry = res.body.data.ending_soon.find((e) => e.id === soon);
    assert.equal(entry.recipient_email, 'rep@renew.test');
    assert.ok(entry.days_left >= 9 && entry.days_left <= 11, String(entry.days_left));
  });

  test('send reminder: 503 without SMTP; sends, records who, refuses a second the same day, resends on confirm', async (t) => {
    const id = await addMember('Remind me', 2600, { expires: new Date(Date.now() + 7 * 86400000), contact: 'rep@remind.test' });
    const noEmail = await addMember('Remind nobody', 2600, { expires: new Date(Date.now() + 7 * 86400000) });

    t.mock.method(emailService, 'isEmailConfigured', () => false);
    let res = await call('boss', 'POST', `/admin/membership-renewals/${id}/remind`, {});
    assert.equal(res.status, 503);
    assert.equal((await q('SELECT last_reminder_sent_at FROM businesses WHERE id = $1', [id])).rows[0].last_reminder_sent_at, null);

    emailService.isEmailConfigured.mock.restore();
    t.mock.method(emailService, 'isEmailConfigured', () => true);
    const sent = [];
    t.mock.method(emailService, 'sendMembershipRenewalReminder', async (args) => { sent.push(args); });

    res = await call('boss', 'POST', `/admin/membership-renewals/${noEmail}/remind`, {});
    assert.equal(res.status, 400);

    res = await call('boss', 'POST', `/admin/membership-renewals/${id}/remind`, {});
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].toEmail, 'rep@remind.test');
    assert.equal(res.body.data.renewal.reminded_today, true);
    assert.equal(res.body.data.renewal.last_reminder_sent_by_name, 'Addons boss');
    const stored = (await q('SELECT last_reminder_sent_at, last_reminder_sent_by FROM businesses WHERE id = $1', [id])).rows[0];
    assert.ok(stored.last_reminder_sent_at);
    assert.equal(stored.last_reminder_sent_by, users.boss);

    res = await call('boss', 'POST', `/admin/membership-renewals/${id}/remind`, {});
    assert.equal(res.status, 409);
    assert.equal(sent.length, 1);

    res = await call('boss', 'POST', `/admin/membership-renewals/${id}/remind`, { resend: true });
    assert.equal(res.status, 200);
    assert.equal(sent.length, 2);

    const list = await call('boss', 'GET', '/admin/membership-renewals');
    assert.equal(list.body.data.email_configured, true);
    assert.equal(list.body.data.ending_soon.find((e) => e.id === id).reminded_today, true);
  });

  test('two clicks at once send one reminder', async (t) => {
    const id = await addMember('Double click', 2600, { expires: new Date(Date.now() + 7 * 86400000), contact: 'rep@double.test' });
    t.mock.method(emailService, 'isEmailConfigured', () => true);
    const sent = [];
    t.mock.method(emailService, 'sendMembershipRenewalReminder', async (args) => {
      sent.push(args);
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const results = await Promise.all([
      call('boss', 'POST', `/admin/membership-renewals/${id}/remind`, {}),
      call('boss', 'POST', `/admin/membership-renewals/${id}/remind`, {}),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(sent.length, 1);
  });

  test('a mail server failure records nothing', async (t) => {
    const id = await addMember('Mail down', 2600, { expires: new Date(Date.now() + 7 * 86400000), contact: 'rep@down.test' });
    silence(t);
    t.mock.method(emailService, 'isEmailConfigured', () => true);
    t.mock.method(emailService, 'sendMembershipRenewalReminder', async () => { throw new Error('connect ECONNREFUSED'); });
    const res = await call('boss', 'POST', `/admin/membership-renewals/${id}/remind`, {});
    assert.equal(res.status, 502);
    assert.equal((await q('SELECT last_reminder_sent_at FROM businesses WHERE id = $1', [id])).rows[0].last_reminder_sent_at, null);
  });

  test('a signed-in non-admin cannot reach campaigns or reminders', async () => {
    assert.equal((await call('ann', 'GET', '/admin/membership-campaigns')).status, 403);
    assert.equal((await call('ann', 'GET', '/admin/membership-renewals')).status, 403);
  });
});
