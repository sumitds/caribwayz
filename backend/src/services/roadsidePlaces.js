const fs = require('fs');
const path = require('path');
const { haversineDistance } = require('../utils/haversine');

const DATA_FILE = path.join(__dirname, '..', 'data', 'roadside_places.json');

/**
 * Which stored kinds answer each Services lookup. The keys are the lookup keys
 * the mobile app sends (RoadsideService.lookupKey), and the kinds mirror the
 * OSM tags the app's own Overpass fallback queries for the same key, so both
 * sources list the same kind of places.
 */
const LOOKUP_KINDS = {
  roadside_towing: ['towing', 'car_repair', 'tyres'],
  roadside_mechanic: ['car_repair'],
  roadside_tyres: ['tyres', 'tyres_service'],
  roadside_locksmith: ['locksmith'],
  roadside_battery: ['batteries', 'car_parts', 'car_repair'],
  roadside_fuel: ['fuel'],
  roadside_winch: ['towing', 'car_repair'],
  roadside_overheating: ['car_repair'],
};

const MAX_RESULTS = 200;
const SEED_BATCH = 500;

let cachedDataset = null;

/** The bundled dataset, read once. Throws when the file is missing or malformed. */
const loadDataset = (file = DATA_FILE) => {
  if (cachedDataset && file === DATA_FILE) return cachedDataset;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed.version !== 'string' || !Array.isArray(parsed.places) ||
      !parsed.territories || typeof parsed.territories !== 'object') {
    throw new Error(`${file} is not a roadside places dataset`);
  }
  if (file === DATA_FILE) cachedDataset = parsed;
  return parsed;
};

/** The territory code whose box contains the point, or null outside them all. */
const territoryFor = (latitude, longitude, territories) => {
  for (const [code, [south, west, north, east]] of Object.entries(territories)) {
    if (latitude >= south && latitude <= north && longitude >= west && longitude <= east) {
      return code;
    }
  }
  return null;
};

/**
 * Loads the dataset into roadside_places when the stored version differs.
 *
 * Runs on every boot, so it is cheap when nothing changed: one query. Rows are
 * upserted in batches with a single array parameter per column, then rows from
 * any older version are removed, so a place deleted from OpenStreetMap stops
 * being listed. Never throws: a failure is logged and the server keeps serving
 * whatever the table already holds.
 */
const seedRoadsidePlaces = async (query, dataset = null) => {
  try {
    const data = dataset || loadDataset();
    const current = await query(
      'SELECT COUNT(*)::int AS n FROM roadside_places WHERE dataset_version = $1',
      [data.version]
    );
    if (current.rows[0] && current.rows[0].n === data.places.length) {
      console.log(`[Roadside] Dataset ${data.version} already loaded (${data.places.length} places).`);
      return { loaded: 0, skipped: true };
    }

    let loaded = 0;
    for (let i = 0; i < data.places.length; i += SEED_BATCH) {
      const batch = data.places.slice(i, i + SEED_BATCH);
      await query(
        `INSERT INTO roadside_places (osm_key, latitude, longitude, territory, kinds, tags, dataset_version)
         SELECT k, la, lo, t, string_to_array(ki, ','), tg::jsonb, $7
           FROM unnest($1::text[], $2::float8[], $3::float8[], $4::text[], $5::text[], $6::text[])
             AS x(k, la, lo, t, ki, tg)
         ON CONFLICT (osm_key) DO UPDATE SET
           latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
           territory = EXCLUDED.territory, kinds = EXCLUDED.kinds,
           tags = EXCLUDED.tags, dataset_version = EXCLUDED.dataset_version`,
        [
          batch.map((p) => `${p.type}/${p.id}`),
          batch.map((p) => p.lat),
          batch.map((p) => p.lon),
          batch.map((p) => p.territory),
          batch.map((p) => p.kinds.join(',')),
          batch.map((p) => JSON.stringify(p.tags || {})),
          data.version,
        ]
      );
      loaded += batch.length;
    }
    await query('DELETE FROM roadside_places WHERE dataset_version <> $1', [data.version]);
    console.log(`[Roadside] Loaded dataset ${data.version}: ${loaded} places.`);
    return { loaded, skipped: false };
  } catch (err) {
    console.error('[Roadside] Seeding failed:', err.message);
    return { loaded: 0, skipped: false, error: err.message };
  }
};

/**
 * Places of the lookup's kinds within radiusMeters, nearest first, shaped like
 * Overpass elements so the app reads them with the parser it already has.
 */
const findNearby = async (query, { key, latitude, longitude, radiusMeters, limit = MAX_RESULTS }) => {
  const kinds = LOOKUP_KINDS[key];
  if (!kinds) throw new Error(`Unknown lookup key ${key}`);

  // A degree of latitude is about 111 km everywhere; a degree of longitude
  // shrinks with latitude. The box only pre-filters; distance is exact below.
  const latDelta = radiusMeters / 111000;
  const lngDelta = radiusMeters / (111000 * Math.max(Math.cos((latitude * Math.PI) / 180), 0.01));
  const result = await query(
    `SELECT osm_key, latitude, longitude, tags
       FROM roadside_places
      WHERE latitude BETWEEN $1 AND $2
        AND longitude BETWEEN $3 AND $4
        AND kinds && $5::text[]`,
    [latitude - latDelta, latitude + latDelta, longitude - lngDelta, longitude + lngDelta, kinds]
  );

  return result.rows
    .map((row) => ({
      row,
      meters: haversineDistance(latitude, longitude, Number(row.latitude), Number(row.longitude)) * 1000,
    }))
    .filter(({ meters }) => meters <= radiusMeters)
    .sort((a, b) => a.meters - b.meters)
    .slice(0, Math.min(limit, MAX_RESULTS))
    .map(({ row }) => {
      const [type, id] = String(row.osm_key).split('/');
      return {
        type,
        id: Number(id),
        lat: Number(row.latitude),
        lon: Number(row.longitude),
        tags: row.tags || {},
      };
    });
};

module.exports = {
  LOOKUP_KINDS,
  MAX_RESULTS,
  loadDataset,
  territoryFor,
  seedRoadsidePlaces,
  findNearby,
};
