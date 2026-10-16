const fs = require('fs');
const path = require('path');
const { haversineDistance } = require('../utils/haversine');

const DATA_FILE = path.join(__dirname, '..', 'data', 'emergency_shelters.json');

const MAX_RESULTS = 200;
const SEED_BATCH = 500;

let cachedDataset = null;

/** The bundled dataset, read once. Throws when the file is missing or malformed. */
const loadDataset = (file = DATA_FILE) => {
  if (cachedDataset && file === DATA_FILE) return cachedDataset;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed.version !== 'string' || !Array.isArray(parsed.shelters) ||
      !parsed.territories || typeof parsed.territories !== 'object') {
    throw new Error(`${file} is not an emergency shelters dataset`);
  }
  if (file === DATA_FILE) cachedDataset = parsed;
  return parsed;
};

/**
 * Loads the dataset into emergency_shelters when the stored version differs.
 *
 * Runs on every boot, so it is cheap when nothing changed: one query. Rows are
 * upserted in batches with a single array parameter per column, then rows from
 * any older version are removed, so a shelter deleted from OpenStreetMap stops
 * being listed. Never throws: a failure is logged and the server keeps serving
 * whatever the table already holds.
 */
const seedEmergencyShelters = async (query, dataset = null) => {
  try {
    const data = dataset || loadDataset();
    const current = await query(
      'SELECT COUNT(*)::int AS n FROM emergency_shelters WHERE dataset_version = $1',
      [data.version]
    );
    if (current.rows[0] && current.rows[0].n === data.shelters.length) {
      console.log(`[Shelters] Dataset ${data.version} already loaded (${data.shelters.length} shelters).`);
      return { loaded: 0, skipped: true };
    }

    let loaded = 0;
    for (let i = 0; i < data.shelters.length; i += SEED_BATCH) {
      const batch = data.shelters.slice(i, i + SEED_BATCH);
      await query(
        `INSERT INTO emergency_shelters (osm_key, latitude, longitude, territory, tags, dataset_version)
         SELECT k, la, lo, t, tg::jsonb, $6
           FROM unnest($1::text[], $2::float8[], $3::float8[], $4::text[], $5::text[])
             AS x(k, la, lo, t, tg)
         ON CONFLICT (osm_key) DO UPDATE SET
           latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
           territory = EXCLUDED.territory, tags = EXCLUDED.tags,
           dataset_version = EXCLUDED.dataset_version`,
        [
          batch.map((s) => `${s.type}/${s.id}`),
          batch.map((s) => s.lat),
          batch.map((s) => s.lon),
          batch.map((s) => s.territory),
          batch.map((s) => JSON.stringify(s.tags || {})),
          data.version,
        ]
      );
      loaded += batch.length;
    }
    await query('DELETE FROM emergency_shelters WHERE dataset_version <> $1', [data.version]);
    console.log(`[Shelters] Loaded dataset ${data.version}: ${loaded} shelters.`);
    return { loaded, skipped: false };
  } catch (err) {
    console.error('[Shelters] Seeding failed:', err.message);
    return { loaded: 0, skipped: false, error: err.message };
  }
};

/**
 * Whether emergency_shelters holds every row of [dataset]'s version. Seeding
 * runs after the server starts listening, so until it finishes (or when it
 * failed) the table holds an older version, part of this one, or nothing.
 * Throws when the database cannot be asked.
 */
const isDatasetLoaded = async (query, dataset) => {
  const result = await query(
    'SELECT COUNT(*)::int AS n FROM emergency_shelters WHERE dataset_version = $1',
    [dataset.version]
  );
  return Boolean(result.rows[0]) && result.rows[0].n === dataset.shelters.length;
};

/**
 * Shelters within radiusMeters, nearest first, shaped like Overpass elements
 * so the app reads them with the parser its Overpass fallback already uses.
 */
const findNearby = async (query, { latitude, longitude, radiusMeters, limit = MAX_RESULTS }) => {
  // A degree of latitude is about 111 km everywhere; a degree of longitude
  // shrinks with latitude. The box only pre-filters; distance is exact below.
  const latDelta = radiusMeters / 111000;
  const lngDelta = radiusMeters / (111000 * Math.max(Math.cos((latitude * Math.PI) / 180), 0.01));
  const result = await query(
    `SELECT osm_key, latitude, longitude, tags
       FROM emergency_shelters
      WHERE latitude BETWEEN $1 AND $2
        AND longitude BETWEEN $3 AND $4`,
    [latitude - latDelta, latitude + latDelta, longitude - lngDelta, longitude + lngDelta]
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
  MAX_RESULTS,
  loadDataset,
  seedEmergencyShelters,
  isDatasetLoaded,
  findNearby,
};
