const db = require('../config/db');
const { notify } = require('./notificationService');
const { haversineDistance } = require('../utils/haversine');

/**
 * Weather alerts: a push to everyone with "Weather alerts" on whose area a
 * hurricane or tropical storm is coming close to.
 *
 * The storms come from the US National Hurricane Center's CurrentStorms.json,
 * the same public-domain feed the app's Disaster Alerts screen reads. A storm
 * counts as close by the same rule the app uses to mark one urgent: a
 * hurricane within 800 km, a tropical storm within 400 km. Weaker systems and
 * storms further out stay on the Disaster Alerts screen without a push.
 *
 * The app reports a rough area (see setAlertArea); nobody without one is sent
 * anything, since there is no way to tell whether a storm is near them.
 *
 * Each person gets each alert once: a row in weather_alert_deliveries is
 * claimed before the push, so a second check, or a second server, finds it
 * taken.
 */

const STORMS_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';

/** The NHC asks callers to identify themselves. */
const USER_AGENT = 'caribwayz-api/1.0 (+https://caribwayz.com)';

const FETCH_TIMEOUT_MS = 20000;

/** Hurricanes (HU, MH) this close are pushed. */
const HURRICANE_RADIUS_KM = 800;

/** Tropical storms (TS) this close are pushed. */
const TROPICAL_STORM_RADIUS_KM = 400;

/**
 * An area not reported for this long is treated as unknown: the person may
 * have gone home from a trip, and a warning for where they were is noise.
 */
const AREA_MAX_AGE_DAYS = 14;

/** Delivery rows older than this are deleted; a storm lasts days, not months. */
const DELIVERY_KEEP_DAYS = 60;

/** Areas are stored to one decimal place, about 11 km. */
const roundArea = (degrees) => Math.round(degrees * 10) / 10;

const STORM_LABELS = Object.freeze({
  HU: 'Hurricane',
  MH: 'Major Hurricane',
  TS: 'Tropical Storm',
});

/** Reads "20.4N" or "107.0W" into signed degrees, or null. */
const hemisphereDegrees = (value) => {
  if (typeof value !== 'string') return null;
  const match = /^(-?\d+(?:\.\d+)?)\s*([NSEW])?$/.exec(value.trim().toUpperCase());
  if (!match) return null;
  const degrees = Number(match[1]);
  if (!Number.isFinite(degrees)) return null;
  return match[2] === 'S' || match[2] === 'W' ? -degrees : degrees;
};

const toNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const validPoint = (lat, lng) =>
  lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/**
 * The storms in a CurrentStorms.json body that are strong enough to push
 * (hurricanes and tropical storms). Returns null when the body is not a
 * recognisable answer, so an outage is never mistaken for a quiet day.
 */
const parseStorms = (body) => {
  let decoded;
  try {
    decoded = typeof body === 'string' ? JSON.parse(body) : body;
  } catch (err) {
    return null;
  }
  if (!decoded || typeof decoded !== 'object' || !Array.isArray(decoded.activeStorms)) return null;

  const storms = [];
  for (const storm of decoded.activeStorms) {
    if (!storm || typeof storm !== 'object') continue;
    const code = String(storm.classification || '').trim().toUpperCase();
    if (!STORM_LABELS[code]) continue;
    const lat = toNumber(storm.latitudeNumeric) ?? hemisphereDegrees(storm.latitude);
    const lng = toNumber(storm.longitudeNumeric) ?? hemisphereDegrees(storm.longitude);
    if (!validPoint(lat, lng)) continue;
    const id = String(storm.id || '').trim();
    const name = String(storm.name || '').trim();
    if (!id && !name) continue;
    const knots = toNumber(storm.intensity);
    storms.push({
      id: id || name,
      name,
      classification: code,
      latitude: lat,
      longitude: lng,
      windKnots: knots !== null && knots > 0 ? knots : null,
    });
  }
  return storms;
};

/** How far a storm of [classification] may be and still be pushed, in km. */
const radiusFor = (classification) =>
  (classification === 'HU' || classification === 'MH' ? HURRICANE_RADIUS_KM : TROPICAL_STORM_RADIUS_KM);

/**
 * Names the storm and its strength, so a tropical storm that becomes a
 * hurricane is a new alert while the same hurricane next advisory is not.
 */
const alertKeyFor = (storm) => `storm:${storm.id}:${storm.classification}`.slice(0, 200);

/** Rounds a distance to something a person would say: 10 km steps, 5 under 50. */
const roughKm = (km) => {
  const step = km < 50 ? 5 : 10;
  return Math.max(step, Math.round(km / step) * step);
};

/** The notification for [storm] at [km] from someone's area. */
const messageFor = (storm, km) => {
  const label = STORM_LABELS[storm.classification];
  const named = storm.name ? `${label} ${storm.name}` : label;
  const shownKm = roughKm(km);
  const miles = roughKm(km * 0.621371);
  const winds = storm.windKnots
    ? ` Winds up to ${Math.round(storm.windKnots * 1.15078)} mph (${Math.round(storm.windKnots * 1.852)} km/h).`
    : '';
  return {
    title: `${named} near you`,
    message: `${named} is about ${shownKm} km (${miles} miles) from your area.${winds} ` +
      'Follow the advice of your local disaster office.',
  };
};

/**
 * Fetches the storm feed. Returns the strong storms, or null on any failure
 * (network, timeout, a non-200 answer, a body that is not the feed).
 */
const fetchStorms = async (fetchImpl = fetch) => {
  let response;
  try {
    response = await fetchImpl(STORMS_URL, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    console.error('[Weather] Storm feed request failed:', err.message);
    return null;
  }
  if (!response.ok) {
    console.error(`[Weather] Storm feed returned ${response.status}`);
    return null;
  }
  let text;
  try {
    text = await response.text();
  } catch (err) {
    console.error('[Weather] Storm feed could not be read:', err.message);
    return null;
  }
  const storms = parseStorms(text);
  if (storms === null) console.error('[Weather] Storm feed answer was not recognised');
  return storms;
};

/**
 * @param {object} deps
 * @param {(text: string, params?: any[]) => Promise<{rows: any[], rowCount: number}>} deps.query
 * @param {(userIds: string[], payload: object) => Promise<number>} deps.notify
 * @param {() => Promise<object[]|null>} deps.fetchStorms
 */
const buildWeatherAlertService = ({ query, notify: send, fetchStorms: loadStorms }) => {
  /**
   * Stores [userId]'s rough area while their weather alerts are on, and
   * reports whether it was stored. With weather alerts off nothing is kept.
   * Throws on a database error.
   */
  const setAlertArea = async (userId, latitude, longitude) => {
    const result = await query(
      `INSERT INTO user_alert_areas (user_id, latitude, longitude, updated_at)
       SELECT u.id, $2, $3, NOW()
         FROM users u
         LEFT JOIN user_preferences p ON p.user_id = u.id
        WHERE u.id = $1 AND COALESCE(p.push_weather, TRUE)
       ON CONFLICT (user_id) DO UPDATE
         SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, updated_at = NOW()`,
      [userId, roundArea(latitude), roundArea(longitude)]
    );
    return result.rowCount > 0;
  };

  /** Forgets [userId]'s area. Throws on a database error. */
  const clearAlertArea = async (userId) => {
    await query('DELETE FROM user_alert_areas WHERE user_id = $1', [userId]);
  };

  /** Everyone who can be sent a weather alert, with their area. */
  const recipients = async () => (await query(
    `SELECT a.user_id, a.latitude, a.longitude
       FROM user_alert_areas a
       JOIN users u ON u.id = a.user_id AND u.status = 'active'
       LEFT JOIN user_preferences p ON p.user_id = a.user_id
      WHERE COALESCE(p.push_weather, TRUE)
        AND a.updated_at > NOW() - make_interval(days => $1)`,
    [AREA_MAX_AGE_DAYS]
  )).rows;

  /**
   * Claims [alertKey] for [userIds] and returns those not already sent it.
   * The claim is the dedupe: a concurrent check cannot claim the same pair.
   */
  const claim = async (userIds, alertKey) => (await query(
    `INSERT INTO weather_alert_deliveries (user_id, alert_key)
     SELECT unnest($1::uuid[]), $2
     ON CONFLICT (user_id, alert_key) DO NOTHING
     RETURNING user_id`,
    [userIds, alertKey]
  )).rows.map((row) => row.user_id);

  /** Gives back claims whose notification could not be written, so the next check retries. */
  const release = async (userIds, alertKey) => {
    try {
      await query(
        'DELETE FROM weather_alert_deliveries WHERE alert_key = $1 AND user_id = ANY($2::uuid[])',
        [alertKey, userIds]
      );
    } catch (err) {
      console.error(`[Weather] Releasing ${userIds.length} claim(s) for ${alertKey} failed:`, err.message);
    }
  };

  /**
   * One check: fetches the storms and sends each close one to everyone in
   * range who has not had it. Never throws.
   *
   * Returns { storms, sent } (storms is null when the feed could not be
   * read, sent counts notifications written), or null when the database
   * failed.
   */
  const runCheck = async () => {
    const storms = await loadStorms();
    if (storms === null) return { storms: null, sent: 0 };

    try {
      await query(
        'DELETE FROM weather_alert_deliveries WHERE sent_at < NOW() - make_interval(days => $1)',
        [DELIVERY_KEEP_DAYS]
      );
    } catch (err) {
      console.error('[Weather] Pruning old deliveries failed:', err.message);
    }
    if (storms.length === 0) return { storms: 0, sent: 0 };

    let people;
    try {
      people = await recipients();
    } catch (err) {
      console.error('[Weather] Reading recipients failed:', err.message);
      return null;
    }

    let sent = 0;
    for (const storm of storms) {
      const radius = radiusFor(storm.classification);
      // Everyone in range, each with the distance from their own area.
      const near = new Map();
      for (const person of people) {
        const km = haversineDistance(person.latitude, person.longitude, storm.latitude, storm.longitude);
        if (km <= radius) near.set(person.user_id, km);
      }
      if (near.size === 0) continue;

      const alertKey = alertKeyFor(storm);
      let claimed;
      try {
        claimed = await claim([...near.keys()], alertKey);
      } catch (err) {
        console.error(`[Weather] Claiming ${alertKey} failed:`, err.message);
        continue;
      }

      // Same message for people at the same rough distance, so one storm is
      // a handful of notify() calls rather than one per person.
      const groups = new Map();
      for (const userId of claimed) {
        const { title, message } = messageFor(storm, near.get(userId));
        const key = `${title}\n${message}`;
        if (!groups.has(key)) groups.set(key, { title, message, userIds: [] });
        groups.get(key).userIds.push(userId);
      }
      for (const { title, message, userIds } of groups.values()) {
        const written = await send(userIds, {
          type: 'system',
          category: 'weather',
          title,
          message,
          data: { alert: 'weather', storm_id: storm.id, classification: storm.classification },
        });
        if (written < 0) {
          await release(userIds, alertKey);
        } else {
          sent += written;
        }
      }
    }
    if (sent > 0) console.log(`[Weather] Sent ${sent} storm alert(s)`);
    return { storms: storms.length, sent };
  };

  return { setAlertArea, clearAlertArea, runCheck };
};

const { setAlertArea, clearAlertArea, runCheck } = buildWeatherAlertService({
  query: db.query,
  notify,
  fetchStorms: () => fetchStorms(),
});

module.exports = {
  buildWeatherAlertService,
  setAlertArea,
  clearAlertArea,
  runCheck,
  parseStorms,
  fetchStorms,
  messageFor,
  alertKeyFor,
  radiusFor,
  roundArea,
  STORMS_URL,
  HURRICANE_RADIUS_KM,
  TROPICAL_STORM_RADIUS_KM,
  AREA_MAX_AGE_DAYS,
};
