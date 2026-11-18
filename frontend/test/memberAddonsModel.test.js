// Admin logic for the membership add-ons (migration 034): featured placement,
// campaigns and renewal reminders. Run with: npm test (node --test).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isCalendarDay, jamaicaToday, addDays, daysBetween, formatDay,
  EMPTY_FEATURED_FORM, featuredFormFrom, featuredPayload, featuredNote,
  emptyCampaignForm, campaignFormFrom, campaignEndDate, campaignPayload, canEndCampaign, campaignUseNote,
  daysLeftLabel, reminderAction, OFFER_MAX, CAMPAIGN_MAX_DAYS,
} from '../src/pages/Admin/memberAddonsModel.js';

const TODAY = '2026-11-18';

describe('Jamaica days', () => {
  test('today goes by Jamaica (UTC-5), not by the admin\'s clock or UTC', () => {
    assert.equal(jamaicaToday(new Date('2026-11-19T04:59:00Z')), '2026-11-18');
    assert.equal(jamaicaToday(new Date('2026-11-19T05:00:00Z')), '2026-11-19');
  });

  test('calendar days, adding days and counting them', () => {
    assert.equal(isCalendarDay('2028-02-29'), true);
    assert.equal(isCalendarDay('2026-02-29'), false);
    assert.equal(isCalendarDay(''), false);
    assert.equal(isCalendarDay(undefined), false);
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(daysBetween('2026-11-18', '2026-11-11'), -7);
  });

  test('a day is written the same in any browser time zone', () => {
    assert.equal(formatDay('2026-12-01'), '1 Dec 2026');
    assert.equal(formatDay('2026-13-01'), '');
    assert.equal(formatDay(null), '');
  });
});

describe('featured placement in the business form', () => {
  test('a new business is not featured', () => {
    assert.deepEqual(featuredPayload({ ...EMPTY_FEATURED_FORM }).body, { is_featured: false, featured_until: null });
  });

  test('ticking it needs the last day; a bad date is refused', () => {
    assert.ok(featuredPayload({ is_featured: true, featured_until: '' }).errors.featured_until);
    assert.ok(featuredPayload({ is_featured: false, featured_until: '2026-02-30' }).errors.featured_until);
    assert.deepEqual(featuredPayload({ is_featured: true, featured_until: '2027-11-18' }).body, { is_featured: true, featured_until: '2027-11-18' });
  });

  test('unticking keeps the date, so it can be ticked again', () => {
    assert.deepEqual(featuredPayload({ is_featured: false, featured_until: '2027-11-18' }).body, { is_featured: false, featured_until: '2027-11-18' });
  });

  test('editing starts from the saved business', () => {
    assert.deepEqual(featuredFormFrom({ is_featured: true, featured_until: '2027-01-05' }), { is_featured: true, featured_until: '2027-01-05' });
    assert.deepEqual(featuredFormFrom({ is_featured: null, featured_until: null }), { is_featured: false, featured_until: '' });
  });

  test('the card says featured until, ended, or not shown; nothing when not ticked', () => {
    assert.deepEqual(featuredNote({ is_featured: true, featured_now: true, featured_until: '2026-11-18' }, TODAY), { live: true, text: 'Featured until 18 Nov 2026' });
    assert.equal(featuredNote({ is_featured: true, featured_now: false, featured_until: '2026-11-17' }, TODAY).text, 'Featured placement ended 17 Nov 2026');
    assert.match(featuredNote({ is_featured: true, featured_now: false, featured_until: '2026-12-01' }, TODAY).text, /not shown in the app/);
    assert.equal(featuredNote({ is_featured: false }, TODAY), null);
  });
});

describe('the campaign form', () => {
  const filled = { ...emptyCampaignForm(TODAY), business_id: 'b1', offer_text: ' 10% off lunch ' };

  test('7, 14 or 30 days count the start day: 7 days from the 18th ends on the 24th', () => {
    assert.equal(campaignEndDate({ ...filled, duration: '7' }), '2026-11-24');
    assert.equal(campaignEndDate({ ...filled, duration: '14' }), '2026-12-01');
    assert.equal(campaignEndDate({ ...filled, duration: '30' }), '2026-12-17');
    assert.equal(campaignEndDate({ ...filled, duration: 'custom', end_date: '2026-12-31' }), '2026-12-31');
    assert.equal(campaignEndDate({ ...filled, start_date: '' }), '');
  });

  test('a new campaign sends the business, trimmed offer and both dates', () => {
    assert.deepEqual(campaignPayload(filled, { today: TODAY }).body, {
      business_id: 'b1', kind: 'promotional', offer_text: '10% off lunch', start_date: TODAY, end_date: '2026-11-24',
    });
  });

  test('a one-day seasonal campaign today is allowed', () => {
    const { body } = campaignPayload({ ...filled, kind: 'seasonal', duration: 'custom', end_date: TODAY }, { today: TODAY });
    assert.equal(body.end_date, TODAY);
  });

  test('missing business, offer, dates, or an offer too long are refused', () => {
    const { errors } = campaignPayload({ ...filled, business_id: '', offer_text: '  ', start_date: '', kind: 'flash' }, { today: TODAY });
    assert.deepEqual(Object.keys(errors).sort(), ['business_id', 'end_date', 'kind', 'offer_text', 'start_date']);
    assert.ok(campaignPayload({ ...filled, offer_text: 'x'.repeat(OFFER_MAX + 1) }, { today: TODAY }).errors.offer_text);
    assert.ok(campaignPayload({ ...filled, offer_text: 'x'.repeat(OFFER_MAX) }, { today: TODAY }).body);
  });

  test('an end before the start, too long, or already over is refused', () => {
    assert.equal(campaignPayload({ ...filled, duration: 'custom', end_date: '2026-11-17' }, { today: TODAY }).errors.end_date, 'On or after the start date');
    assert.match(campaignPayload({ ...filled, duration: 'custom', end_date: addDays(TODAY, CAMPAIGN_MAX_DAYS) }, { today: TODAY }).errors.end_date, /366/);
    assert.ok(campaignPayload({ ...filled, duration: 'custom', end_date: addDays(TODAY, CAMPAIGN_MAX_DAYS - 1) }, { today: TODAY }).body);
    assert.equal(campaignPayload({ ...filled, start_date: '2026-11-01', duration: '7' }, { today: TODAY }).errors.end_date, 'This would already be over');
  });

  test('editing leaves the business out, and may keep dates in the past', () => {
    const form = campaignFormFrom({ business_id: 'b1', kind: 'seasonal', offer_text: 'Xmas', start_date: '2026-11-01', end_date: '2026-11-10' });
    assert.equal(form.duration, 'custom');
    assert.deepEqual(campaignPayload(form, { today: TODAY, editing: true }).body, {
      kind: 'seasonal', offer_text: 'Xmas', start_date: '2026-11-01', end_date: '2026-11-10',
    });
  });

  test('only running or scheduled campaigns can be ended; the note says whether drivers hear it', () => {
    assert.equal(canEndCampaign({ state: 'running' }), true);
    assert.equal(canEndCampaign({ state: 'scheduled' }), true);
    assert.equal(canEndCampaign({ state: 'finished' }), false);
    assert.equal(canEndCampaign({ state: 'ended' }), false);
    assert.equal(campaignUseNote({ state: 'running', in_use: true }), 'Spoken in the app now');
    assert.match(campaignUseNote({ state: 'running', in_use: false }), /started later/);
    assert.equal(campaignUseNote({ state: 'scheduled', in_use: false }), null);
  });
});

describe('renewal reminders', () => {
  test('days left reads naturally either side of the end', () => {
    assert.equal(daysLeftLabel(0, false), 'Ends today');
    assert.equal(daysLeftLabel(1, false), 'Ends tomorrow');
    assert.equal(daysLeftLabel(12, false), 'Ends in 12 days');
    assert.equal(daysLeftLabel(0, true), 'Ended today');
    assert.equal(daysLeftLabel(-1, true), 'Ended yesterday');
    assert.equal(daysLeftLabel(-9, true), 'Ended 9 days ago');
  });

  test('the button: off without SMTP or an email; asks before a second reminder the same day', () => {
    const entry = { name: 'Island Grill', recipient_email: 'rep@grill.test', reminded_today: false };
    assert.deepEqual(reminderAction(entry, true), { disabled: false, label: 'Send reminder' });
    assert.equal(reminderAction(entry, false).disabled, true);
    assert.match(reminderAction(entry, false).reason, /SMTP/);
    assert.equal(reminderAction({ ...entry, recipient_email: null }, true).disabled, true);
    assert.match(reminderAction({ ...entry, recipient_email: null }, true).reason, /No email on file/);
    const again = reminderAction({ ...entry, reminded_today: true }, true);
    assert.equal(again.label, 'Send again');
    assert.match(again.confirm, /already sent to Island Grill today/);
  });
});
