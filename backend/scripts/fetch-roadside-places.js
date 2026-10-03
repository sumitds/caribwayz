#!/usr/bin/env node
/**
 * Builds src/data/roadside_places.json: every roadside-help place OpenStreetMap
 * holds for the Caribbean territories CaribWayz serves.
 *
 * Why it exists: the Services lists used to ask the public Overpass servers at
 * the moment a stranded driver tapped Towing. Those servers are volunteer-run
 * and are regularly busy or down (504s, internal errors), and the list failed
 * with "Could not load". This snapshot is served from the CaribWayz database
 * instead, so the list no longer depends on Overpass being up.
 *
 * Run it again to refresh the data, then commit the file and deploy:
 *   node scripts/fetch-roadside-places.js
 *
 * Uses Node's built-in fetch (Node 18+). No dependencies.
 */
const fs = require('fs');
const path = require('path');

const USER_AGENT = 'caribwayz_api/1.0 (+https://caribwayz.com)';

// Full-planet instances that accept bounding-box queries. The French instance
// has no area index, so territories are given as boxes rather than by name.
const HOSTS = [
  'https://overpass.openstreetmap.fr',
  'https://overpass-api.de',
  'https://overpass.private.coffee',
];

/** [south, west, north, east] per territory, matching lib/utils/constants/emergency_numbers.dart. */
const TERRITORIES = {
  JM: [17.65, -78.45, 18.6, -76.15],
  TT: [9.95, -61.95, 11.4, -60.45],
  BB: [13.0, -59.7, 13.35, -59.4],
  GY: [1.1, -61.45, 8.6, -56.45],
  CU: [19.75, -85.0, 23.35, -74.0],
  HT: [17.95, -74.55, 20.15, -71.6],
  DO: [17.45, -72.05, 19.95, -68.3],
  SR: [1.8, -58.1, 6.1, -53.9],
  LC: [13.65, -61.1, 14.15, -60.85],
  // Sint Maarten and Saint-Martin share one island.
  SX: [17.99, -63.17, 18.13, -62.95],
  CW: [12.0, -69.2, 12.42, -68.7],
  AW: [12.4, -70.1, 12.65, -69.85],
  // West edge just past Bimini (-79.3): further west reaches Miami.
  BS: [20.85, -79.45, 27.3, -72.6],
  PR: [17.85, -67.95, 18.55, -65.2],
  VI: [17.65, -65.1, 18.45, -64.55],
  VG: [18.3, -64.85, 18.8, -64.25],
  KY: [19.25, -81.45, 19.8, -79.7],
  BM: [32.2, -64.95, 32.45, -64.6],
  BZ: [15.85, -89.25, 18.5, -87.45],
  TC: [21.15, -72.5, 21.98, -71.05],
  AG: [16.95, -62.0, 17.75, -61.65],
  KN: [17.08, -62.9, 17.43, -62.5],
  GD: [11.95, -61.85, 12.55, -61.35],
  AI: [18.15, -63.45, 18.3, -62.95],
  VC: [12.55, -61.5, 13.4, -61.1],
  DM: [15.18, -61.5, 15.65, -61.22],
  MS: [16.65, -62.25, 16.85, -62.13],
  GP: [15.8, -61.85, 16.55, -61.0],
  MQ: [14.38, -61.25, 14.9, -60.8],
  BL: [17.86, -62.92, 17.97, -62.78],
};

/** OSM tag -> the "kind" stored for it. A place can have several kinds. */
const KINDS = [
  ['shop', 'car_repair', 'car_repair'],
  ['shop', 'tyres', 'tyres'],
  ['service:vehicle:tyres', 'yes', 'tyres_service'],
  ['service:vehicle:towing', 'yes', 'towing'],
  ['service:vehicle:batteries', 'yes', 'batteries'],
  ['shop', 'car_parts', 'car_parts'],
  ['shop', 'locksmith', 'locksmith'],
  ['craft', 'locksmith', 'locksmith'],
  ['amenity', 'fuel', 'fuel'],
];

/** Tags kept: what the app reads to name, describe and call a place. */
const KEPT_TAGS = new Set([
  'name', 'brand', 'operator', 'phone', 'contact:phone',
  'addr:housenumber', 'addr:street', 'addr:city',
  'shop', 'amenity', 'craft',
  'service:vehicle:towing', 'service:vehicle:tyres', 'service:vehicle:batteries',
]);

const queryFor = ([s, w, n, e]) => {
  const box = `${s},${w},${n},${e}`;
  const clauses = KINDS.map(([k, v]) => `nwr["${k}"="${v}"](${box});`).join('');
  return `[out:json][timeout:180];(${clauses});out center tags;`;
};

const fetchTerritory = async (code, box) => {
  const body = new URLSearchParams({ data: queryFor(box) });
  for (const host of HOSTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(`${host}/api/interpreter`, {
          method: 'POST',
          headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(200000),
        });
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        // Overpass reports a failed query as 200 with a remark and no data.
        if (!Array.isArray(json.elements) || json.remark) {
          throw new Error(`no data: ${json.remark || 'missing elements'}`);
        }
        return { host, elements: json.elements, base: json.osm3s && json.osm3s.timestamp_osm_base };
      } catch (err) {
        console.error(`  ${code} via ${host} (try ${attempt}) failed: ${err.message}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  throw new Error(`every Overpass host failed for ${code}`);
};

const toPlace = (element, territory) => {
  const lat = element.lat ?? (element.center && element.center.lat);
  const lon = element.lon ?? (element.center && element.center.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const tags = element.tags || {};
  const kinds = [...new Set(KINDS.filter(([k, v]) => tags[k] === v).map(([, , kind]) => kind))];
  if (kinds.length === 0) return null;
  const kept = {};
  for (const [k, v] of Object.entries(tags)) if (KEPT_TAGS.has(k)) kept[k] = v;
  return { type: element.type, id: element.id, lat, lon, territory, kinds, tags: kept };
};

const main = async () => {
  const places = new Map();
  let oldestBase = null;
  for (const [code, box] of Object.entries(TERRITORIES)) {
    const { host, elements, base } = await fetchTerritory(code, box);
    let added = 0;
    for (const element of elements) {
      const place = toPlace(element, code);
      if (!place) continue;
      const key = `${place.type}/${place.id}`;
      if (!places.has(key)) { places.set(key, place); added++; }
    }
    if (base && (!oldestBase || base < oldestBase)) oldestBase = base;
    console.log(`${code}: ${added} places (${host})`);
  }

  const out = {
    // Changing data changes this, which makes the server re-seed on start.
    version: new Date().toISOString(),
    source: 'OpenStreetMap contributors, ODbL',
    osm_base: oldestBase,
    territories: TERRITORIES,
    places: [...places.values()].sort((a, b) => (a.type + a.id).localeCompare(b.type + b.id)),
  };
  const file = path.join(__dirname, '..', 'src', 'data', 'roadside_places.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  console.log(`\nWrote ${out.places.length} places to ${file}`);
};

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
