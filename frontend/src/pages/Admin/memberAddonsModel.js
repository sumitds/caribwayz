// Admin logic for the Version 1 membership add-ons (migration 034,
// docs/members-contract.md): featured placement, promotional and seasonal
// campaigns, and the renewal reminders list. Kept free of React so it runs
// under node --test.
//
// Featured placement and campaigns go by the calendar day in Jamaica
// (America/Jamaica), both ends inclusive, as the API does.

export const MEMBER_TIME_ZONE = 'America/Jamaica';
export const CAMPAIGN_KINDS = ['promotional', 'seasonal'];
export const CAMPAIGN_STATES = ['running', 'scheduled', 'finished', 'ended'];
/** The quick lengths offered for a campaign, in days; 'custom' takes an end date. */
export const CAMPAIGN_DURATIONS = ['7', '14', '30', 'custom'];
/** The offer is spoken in the app, so it has the promotion's limit. */
export const OFFER_MAX = 280;
/** The API's longest campaign, so a mistyped year is caught. */
export const CAMPAIGN_MAX_DAYS = 366;

const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Whether [value] is a real calendar day written YYYY-MM-DD (what <input type="date"> gives). */
export const isCalendarDay = (value) => {
  if (typeof value !== 'string') return false;
  const match = CALENDAR_DAY.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

/** Today in Jamaica, YYYY-MM-DD, whatever the admin's own time zone. */
export const jamaicaToday = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MEMBER_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};

/** [day] (YYYY-MM-DD) moved by [days] calendar days. */
export const addDays = (day, days) => {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
};

/** Calendar days from [fromDay] to [toDay]; negative when toDay is earlier. */
export const daysBetween = (fromDay, toDay) => {
  const utc = (day) => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((utc(toDay) - utc(fromDay)) / 86400000);
};

/** "18 Nov 2026" for a YYYY-MM-DD day, or '' when it is not one. Never shifted by the browser's time zone. */
export const formatDay = (day) => {
  if (!isCalendarDay(day)) return '';
  const [year, month, date] = day.split('-').map(Number);
  return `${date} ${MONTHS[month - 1]} ${year}`;
};

// Featured placement

export const EMPTY_FEATURED_FORM = Object.freeze({ is_featured: false, featured_until: '' });

/** The featured part of the business edit form, from a saved business. */
export const featuredFormFrom = (business) => ({
  is_featured: business?.is_featured === true,
  featured_until: isCalendarDay(business?.featured_until) ? business.featured_until : '',
});

/**
 * The featured fields of a POST or PATCH /admin/businesses body, or
 * { errors }. Ticking Featured needs an end date; unticking keeps the date
 * so it can be ticked again, and an empty date is sent as null.
 */
export const featuredPayload = (form) => {
  const until = String(form?.featured_until ?? '').trim();
  if (until !== '' && !isCalendarDay(until)) return { errors: { featured_until: 'A date' } };
  if (form?.is_featured === true && until === '') {
    return { errors: { featured_until: 'Give the last day it is featured' } };
  }
  return { body: { is_featured: form?.is_featured === true, featured_until: until === '' ? null : until } };
};

/**
 * What a business card says about featured placement: shown in the app now,
 * ticked but not shown (past its end, or not a member the app shows), or
 * nothing when it is not ticked.
 */
export const featuredNote = (business, today) => {
  if (business?.is_featured !== true) return null;
  const until = business.featured_until;
  if (business.featured_now === true) return { live: true, text: `Featured until ${formatDay(until)}` };
  if (isCalendarDay(until) && until < today) return { live: false, text: `Featured placement ended ${formatDay(until)}` };
  return { live: false, text: 'Featured, but not shown in the app (membership not active)' };
};

// Campaigns

export const CAMPAIGN_STATE_LABELS = Object.freeze({
  scheduled: 'Scheduled', running: 'Running', finished: 'Finished', ended: 'Ended early',
});

export const emptyCampaignForm = (today) => ({
  business_id: '', kind: 'promotional', offer_text: '', start_date: today, duration: '7', end_date: '',
});

/** A saved campaign as the edit form's state; its own dates count as custom. */
export const campaignFormFrom = (campaign) => ({
  business_id: campaign.business_id,
  kind: campaign.kind,
  offer_text: campaign.offer_text || '',
  start_date: campaign.start_date || '',
  duration: 'custom',
  end_date: campaign.end_date || '',
});

/**
 * The last day of the campaign in [form]: start + 7, 14 or 30 days less one
 * (a 7-day campaign starting on the 1st ends on the 7th), or the date typed
 * for custom dates. '' when it cannot be worked out.
 */
export const campaignEndDate = (form) => {
  if (form.duration === 'custom') return form.end_date || '';
  const days = Number(form.duration);
  if (!isCalendarDay(form.start_date) || !Number.isInteger(days) || days < 1) return '';
  return addDays(form.start_date, days - 1);
};

/**
 * The body for POST (or, with [editing], PATCH) /admin/membership-campaigns,
 * or { errors }. A new campaign must not already be over on [today].
 */
export const campaignPayload = (form, { today, editing = false }) => {
  const errors = {};
  if (!editing && !form.business_id) errors.business_id = 'Choose a business';
  if (!CAMPAIGN_KINDS.includes(form.kind)) errors.kind = 'Choose promotional or seasonal';
  const offer = String(form.offer_text ?? '').trim();
  if (offer === '') errors.offer_text = 'The offer drivers hear is required';
  else if (offer.length > OFFER_MAX) errors.offer_text = `At most ${OFFER_MAX} characters`;
  if (!isCalendarDay(form.start_date)) errors.start_date = 'A start date';
  const end = campaignEndDate(form);
  if (!isCalendarDay(end)) errors.end_date = 'An end date';
  else if (!errors.start_date && end < form.start_date) errors.end_date = 'On or after the start date';
  else if (!errors.start_date && daysBetween(form.start_date, end) + 1 > CAMPAIGN_MAX_DAYS) {
    errors.end_date = `At most ${CAMPAIGN_MAX_DAYS} days`;
  } else if (!editing && end < today) errors.end_date = 'This would already be over';
  if (Object.keys(errors).length > 0) return { errors };
  const body = { kind: form.kind, offer_text: offer, start_date: form.start_date, end_date: end };
  if (!editing) body.business_id = form.business_id;
  return { body };
};

/** Whether a campaign can still be ended early (it has not finished or been ended). */
export const canEndCampaign = (campaign) => campaign?.state === 'running' || campaign?.state === 'scheduled';

/** A line under a campaign about whether drivers hear it now. */
export const campaignUseNote = (campaign) => {
  if (campaign?.state !== 'running') return null;
  return campaign.in_use
    ? 'Spoken in the app now'
    : 'Not spoken now: a campaign that started later is running for this business';
};

// Renewal reminders

/** "Ends today", "Ends in 5 days", "Ended yesterday", "Ended 5 days ago". */
export const daysLeftLabel = (days, expired) => {
  if (!expired) {
    if (days <= 0) return 'Ends today';
    if (days === 1) return 'Ends tomorrow';
    return `Ends in ${days} days`;
  }
  if (days >= 0) return 'Ended today';
  if (days === -1) return 'Ended yesterday';
  return `Ended ${-days} days ago`;
};

/**
 * What the Send reminder button on [entry] does: disabled with a reason when
 * the server has no SMTP or the business has no email; "Send again" with a
 * confirmation when one already went out today.
 */
export const reminderAction = (entry, emailConfigured) => {
  if (!emailConfigured) {
    return { disabled: true, label: 'Send reminder', reason: 'Email (SMTP) is not set up on the server.' };
  }
  if (!entry?.recipient_email) {
    return { disabled: true, label: 'Send reminder', reason: 'No email on file. Add one on the Member Businesses page.' };
  }
  if (entry.reminded_today) {
    return { disabled: false, label: 'Send again', confirm: `A reminder was already sent to ${entry.name} today. Send another?` };
  }
  return { disabled: false, label: 'Send reminder' };
};
