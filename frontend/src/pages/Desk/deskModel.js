// Pure logic for the Emergency Desk page, kept free of React so it can be
// tested with node:test (see admin/test/deskModel.test.js).

export const TYPE_LABELS = {
  medical: 'Medical',
  accident: 'Accident',
  fire: 'Fire',
  crime: 'Crime',
  breakdown: 'Breakdown',
  other: 'Other',
};

/** "Medical" for medical; an unknown type is spelled out rather than hidden. */
export const typeLabel = (type) => {
  if (TYPE_LABELS[type]) return TYPE_LABELS[type];
  const text = String(type ?? '').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1).replace(/_/g, ' ') : 'Unknown';
};

const time = (value) => {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
};

const sameId = (a, b) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();

/**
 * Splits the open feed into the queue the operator works from.
 *
 * - waiting: nobody has taken it; oldest first, because the person who has
 *   waited longest is the most urgent.
 * - mine: taken by this operator; oldest first.
 * - others: taken by another operator; shown so nobody duplicates the work.
 *
 * Alerts whose desk_state is missing (an older API) count as waiting unless
 * acknowledged_at is set, so nothing is ever silently dropped.
 */
export const groupAlerts = (alerts, myUserId) => {
  const waiting = [];
  const mine = [];
  const others = [];
  for (const alert of Array.isArray(alerts) ? alerts : []) {
    if (!alert || alert.status === 'resolved' || alert.desk_state === 'resolved') continue;
    const taken = alert.desk_state ? alert.desk_state === 'acknowledged' : Boolean(alert.acknowledged_at);
    if (!taken) waiting.push(alert);
    else if (sameId(alert.acknowledged_by, myUserId)) mine.push(alert);
    else others.push(alert);
  }
  const oldestFirst = (a, b) => time(a.created_at) - time(b.created_at);
  return { waiting: waiting.sort(oldestFirst), mine: mine.sort(oldestFirst), others: others.sort(oldestFirst) };
};

/**
 * Ids that are waiting now but were not waiting in the previous poll, so the
 * page can alert the operator once per new emergency, not on every refresh.
 * The first load (previous === null) alerts for nothing: those were already
 * on screen for whoever had the desk open.
 */
export const newlyWaiting = (previousIds, currentWaiting) => {
  if (previousIds === null) return [];
  const before = new Set(previousIds);
  return currentWaiting.map((a) => a.id).filter((id) => !before.has(id));
};

/** Whole minutes since [createdAt], never negative (clock skew). */
export const minutesWaiting = (createdAt, now = Date.now()) => {
  const t = time(createdAt);
  if (!t) return null;
  return Math.max(0, Math.floor((now - t) / 60000));
};

/** "just now", "4 min", "1 h 05 min". */
export const formatWaiting = (createdAt, now = Date.now()) => {
  const minutes = minutesWaiting(createdAt, now);
  if (minutes === null) return 'unknown';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = String(minutes % 60).padStart(2, '0');
  return `${h} h ${m} min`;
};

/** "just now" or "4 min ago": never "just now ago". */
export const formatAgo = (value, now = Date.now()) => {
  const text = formatWaiting(value, now);
  return text === 'just now' || text === 'unknown' ? text : `${text} ago`;
};

/** An alert waiting this long with nobody on it is shown as overdue. */
export const OVERDUE_MINUTES = 5;

export const isOverdue = (alert, now = Date.now()) => {
  const minutes = minutesWaiting(alert.created_at, now);
  return alert.desk_state !== 'acknowledged' && minutes !== null && minutes >= OVERDUE_MINUTES;
};

const validCoordinate = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/**
 * A number from an API value, or NaN when it is missing. Number(null) and
 * Number('') are 0, which would put a missing location at 0,0 off Africa.
 */
const coordinate = (value) =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '') ? NaN : Number(value);

/** OpenStreetMap link centred on the alert, or null for a bad coordinate. */
export const mapLink = (lat, lng) => {
  const la = coordinate(lat);
  const ln = coordinate(lng);
  if (!validCoordinate(la, ln)) return null;
  return `https://www.openstreetmap.org/?mlat=${la.toFixed(6)}&mlon=${ln.toFixed(6)}#map=17/${la.toFixed(6)}/${ln.toFixed(6)}`;
};

/** Coordinates as an operator reads them out over the phone. */
export const hasLocation = (lat, lng) => validCoordinate(coordinate(lat), coordinate(lng));

/** Coordinates as an operator reads them out over the phone. */
export const formatCoordinates = (lat, lng) => {
  const la = coordinate(lat);
  const ln = coordinate(lng);
  if (!validCoordinate(la, ln)) return 'Location unavailable';
  return `${la.toFixed(5)}, ${ln.toFixed(5)}`;
};

/** A tel: link for the reporter's phone, or null when there is no usable number. */
export const telLink = (phone) => {
  const cleaned = String(phone ?? '').replace(/[^\d+]/g, '');
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return `tel:${cleaned}`;
};

/** The reporter's name, or a neutral label for an account without one. */
export const reporterLabel = (name) => {
  const text = String(name ?? '').trim().replace(/\s+/g, ' ');
  return text && text.toLowerCase() !== 'default' ? text : 'Name not given';
};

/** The browser tab title: the waiting count is visible from another tab. */
export const pageTitle = (waitingCount) =>
  waitingCount > 0 ? `(${waitingCount}) Waiting - CaribWayz Emergency Desk` : 'CaribWayz Emergency Desk';

/** A readable message from an axios error, for toasts. */
export const errorMessage = (err, fallback) =>
  err?.response?.data?.message || (err?.request && !err?.response ? 'Cannot reach the server. Check the connection.' : fallback);
