#!/usr/bin/env node
/**
 * Builds src/data/emergency_shelters.json: every disaster shelter and
 * evacuation point OpenStreetMap holds for the Caribbean territories CaribWayz
 * serves.
 *
 * Why it exists: the Shelters map layer and the Emergency Shelters list used to
 * ask the public Overpass servers live. Those servers are volunteer-run and are
 * regularly busy or down, and a hurricane is exactly when everyone asks at once.
 * This snapshot is served from the CaribWayz database instead, the same way the
 * roadside directory is (scripts/fetch-roadside-places.js).
 *
 * The territories are the roadside directory's, read from
 * src/data/roadside_places.json, so both datasets cover the same places.
 *
 * Run it again to refresh the data, then commit the file and deploy:
 *   node scripts/fetch-emergency-shelters.js
 *
 * Uses Node's built-in fetch (Node 18+). No dependencies.
 */
const fs = require('fs');
const path = require('path');

const USER_AGENT = 'caribwayz_api/1.0 (+https://caribwayz.com)';

const HOSTS = [
  'https://overpass.openstreetmap.fr',
  'https://overpass-api.de',
  'https://overpass.private.coffee',
];

const ROADSIDE_FILE = path.join(__dirname, '..', 'src', 'data', 'roadside_places.json');
const OUT_FILE = path.join(__dirname, '..', 'src', 'data', 'emergency_shelters.json');

/**
 * The same selection the app's own Overpass fallback makes
 * (mobile/lib/utils/services/disaster/emergency_shelters.dart), so both
 * sources list the same places:
 *  - evacuation_center=yes: buildings on a government shelter list;
 *  - emergency=assembly_point: evacuation and muster points;
 *  - social_facility=shelter, minus those mapped for one group only
 *    (homeless people, women, children and so on);
 *  - amenity=shelter tagged shelter_type=emergency, or named as a hurricane,
 *    cyclone, emergency or evacuation shelter. Plain amenity=shelter is mostly
 *    bus stops and picnic huts, so it is never taken on its own.
 */
const SINGLE_GROUP_FACILITIES =
  'homeless|abused|women|underprivileged|drug_addicted|juvenile|child|senior|disabled|' +
  'migrant|refugees|diseased|mental_health|single_mother|orphan';
const SHELTER_NAMES =
  'hurricane|cyclone|emergency|evacuation|hurac[aá]n|cicl[oó]n|ouragan|cyclonique|damnificados';

/** Tags kept: what the app reads to name, classify, place and call a shelter. */
const KEPT_TAGS = new Set([
  'name', 'operator', 'phone', 'contact:phone',
  'addr:housenumber', 'addr:street', 'addr:city',
  'amenity', 'shelter_type', 'social_facility', 'emergency', 'evacuation_center',
]);

const queryFor = ([s, w, n, e]) => {
  const box = `(${s},${w},${n},${e})`;
  return '[out:json][timeout:180];' +
    `nwr["amenity"="shelter"]${box}->.s;` +
    `nwr["social_facility"="shelter"]${box}->.f;(` +
    `nwr["evacuation_center"="yes"]${box};` +
    `nwr["emergency"="assembly_point"]${box};` +
    `nwr.f["social_facility:for"!~"^(${SINGLE_GROUP_FACILITIES})$"];` +
    'nwr.s["shelter_type"="emergency"];' +
    `nwr.s["name"~"${SHELTER_NAMES}",i];` +
    ');out center tags;';
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

const toShelter = (element, territory) => {
  const lat = element.lat ?? (element.center && element.center.lat);
  const lon = element.lon ?? (element.center && element.center.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const tags = element.tags || {};
  const kept = {};
  for (const [k, v] of Object.entries(tags)) if (KEPT_TAGS.has(k)) kept[k] = v;
  return { type: element.type, id: element.id, lat, lon, territory, tags: kept };
};

const main = async () => {
  const roadside = JSON.parse(fs.readFileSync(ROADSIDE_FILE, 'utf8'));
  if (!roadside || !roadside.territories || typeof roadside.territories !== 'object') {
    throw new Error(`${ROADSIDE_FILE} has no territories`);
  }
  const territories = roadside.territories;

  const shelters = new Map();
  const counts = {};
  let oldestBase = null;
  for (const [code, box] of Object.entries(territories)) {
    const { host, elements, base } = await fetchTerritory(code, box);
    let added = 0;
    for (const element of elements) {
      const shelter = toShelter(element, code);
      if (!shelter) continue;
      const key = `${shelter.type}/${shelter.id}`;
      if (!shelters.has(key)) { shelters.set(key, shelter); added++; }
    }
    counts[code] = added;
    if (base && (!oldestBase || base < oldestBase)) oldestBase = base;
    console.log(`${code}: ${added} shelters (${host})`);
  }

  const out = {
    // Changing data changes this, which makes the server re-seed on start.
    version: new Date().toISOString(),
    source: 'OpenStreetMap contributors, ODbL',
    osm_base: oldestBase,
    territories,
    counts,
    shelters: [...shelters.values()].sort((a, b) => (a.type + a.id).localeCompare(b.type + b.id)),
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  console.log(`\nWrote ${out.shelters.length} shelters to ${OUT_FILE}`);
};

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
