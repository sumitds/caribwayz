// Covers the CaribWayz shelter directory behind the Shelters map layer and the
// Emergency Shelters list.
//
// Both used to ask the public Overpass servers live, which are busiest exactly
// when a storm is coming. The directory serves the same OpenStreetMap shelters
// from CaribWayz's own database.
//
// The last block runs the migration, seeding and lookup against Postgres when
// TEST_DATABASE_URL points at a throwaway database.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const shelters = require('../src/services/emergencyShelters');
const { buildShelterHandlers } = require('../src/controllers/shelterController');

const TERRITORIES = { JM: [17.65, -78.45, 18.6, -76.15], BB: [13.0, -59.7, 13.35, -59.4] };
const KINGSTON = { lat: 18.0179, lng: -76.8099 };

const makeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

// [loaded] stands in for the check that the table holds this dataset version.
const handler = ({ rows = [], fail = false, calls = [], loadDataset, loaded = async () => true } = {}) =>
  buildShelterHandlers({
    query: async (text, params) => {
      calls.push({ text, params });
      if (fail) throw new Error('db down');
      return { rows };
    },
    loadDataset: loadDataset || (() => ({ version: 'v1', territories: TERRITORIES, shelters: [] })),
    findNearby: shelters.findNearby,
    isDatasetLoaded: loaded,
  }).getShelters;

const quiet = async (fn) => {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
};

describe('the bundled dataset', () => {
  test('loads, and every shelter sits inside its own territory box', () => {
    const data = shelters.loadDataset();
    assert.ok(data.shelters.length > 0);
    assert.match(data.source, /OpenStreetMap/);
    const keys = new Set();
    for (const s of data.shelters) {
      const [south, west, north, east] = data.territories[s.territory];
      assert.ok(s.lat >= south && s.lat <= north && s.lon >= west && s.lon <= east, `${s.type}/${s.id}`);
      assert.ok(['node', 'way', 'relation'].includes(s.type));
      assert.ok(!keys.has(`${s.type}/${s.id}`), 'no duplicates');
      keys.add(`${s.type}/${s.id}`);
    }
  });

  test('covers the same territories as the roadside directory', () => {
    const roadside = require('../src/services/roadsidePlaces').loadDataset();
    assert.deepEqual(shelters.loadDataset().territories, roadside.territories);
  });

  test('a malformed file is refused', () => {
    assert.throws(() => shelters.loadDataset(path.join(__dirname, '..', 'package.json')), /not an emergency shelters dataset/);
  });
});

describe('GET /shelters', () => {
  test('returns nearby shelters nearest first, shaped like Overpass elements', async () => {
    const calls = [];
    const rows = [
      { osm_key: 'node/2', latitude: 18.06, longitude: -76.81, tags: { name: 'Far School', evacuation_center: 'yes' } },
      { osm_key: 'way/1', latitude: '18.0185', longitude: '-76.8099', tags: { name: 'Near School', evacuation_center: 'yes' } },
      // Inside the pre-filter box but beyond the radius: dropped.
      { osm_key: 'node/3', latitude: 18.0179, longitude: -76.75, tags: { name: 'Corner Church' } },
    ];
    const res = makeRes();
    await handler({ rows, calls })(
      { query: { lat: String(KINGSTON.lat), lng: String(KINGSTON.lng), radius: '5000' } },
      res
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.covered, true);
    assert.equal(res.body.data.territory, 'JM');
    assert.equal(res.body.data.dataset, 'v1');
    assert.deepEqual(res.body.data.elements.map((e) => e.tags.name), ['Near School', 'Far School']);
    assert.deepEqual(res.body.data.elements[0], {
      type: 'way', id: 1, lat: 18.0185, lon: -76.8099, tags: { name: 'Near School', evacuation_center: 'yes' },
    });
  });

  test('defaults to 30 km and the nearest 40', async () => {
    const calls = [];
    const rows = Array.from({ length: 45 }, (_, i) => ({
      osm_key: `node/${i + 1}`, latitude: KINGSTON.lat + i * 0.001, longitude: KINGSTON.lng, tags: {},
    }));
    const res = makeRes();
    await handler({ rows, calls })({ query: { lat: String(KINGSTON.lat), lng: String(KINGSTON.lng) } }, res);
    const latSpan = calls[0].params[1] - calls[0].params[0];
    assert.ok(Math.abs(latSpan - (2 * 30000) / 111000) < 1e-9);
    assert.equal(res.body.data.elements.length, 40);
    assert.equal(res.body.data.elements[0].id, 1);
  });

  test('limit is honoured and capped at 200', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({
      osm_key: `node/${i + 1}`, latitude: KINGSTON.lat, longitude: KINGSTON.lng + i * 0.0001, tags: {},
    }));
    let res = makeRes();
    await handler({ rows })({ query: { lat: String(KINGSTON.lat), lng: String(KINGSTON.lng), limit: '3' } }, res);
    assert.equal(res.body.data.elements.length, 3);
    res = makeRes();
    await handler({ rows })({ query: { lat: String(KINGSTON.lat), lng: String(KINGSTON.lng), limit: '5000' } }, res);
    assert.equal(res.body.data.elements.length, 200);
  });

  test('outside every covered territory, says so and does not query', async () => {
    const calls = [];
    const res = makeRes();
    await handler({ calls })({ query: { lat: '22.58', lng: '88.47' } }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data, { covered: false, territory: null, elements: [] });
    assert.equal(calls.length, 0);
  });

  test('an empty answer inside a territory is a real "nothing nearby"', async () => {
    const res = makeRes();
    await handler({ rows: [] })({ query: { lat: '13.1', lng: '-59.6' } }, res);
    assert.equal(res.body.data.covered, true);
    assert.equal(res.body.data.territory, 'BB');
    assert.deepEqual(res.body.data.elements, []);
  });

  test('inside a territory but before this dataset version is in the table, is not covered and does not search', async () => {
    const calls = [];
    const asked = [];
    const res = makeRes();
    await handler({ calls, loaded: async (_query, data) => { asked.push(data.version); return false; } })(
      { query: { lat: String(KINGSTON.lat), lng: String(KINGSTON.lng) } }, res
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data, { covered: false, territory: 'JM', elements: [] });
    assert.deepEqual(asked, ['v1']);
    assert.equal(calls.length, 0);
  });

  test('a failure checking the loaded version is a 500, logged', async () => {
    const res = makeRes();
    await quiet(() => handler({ loaded: async () => { throw new Error('db down'); } })(
      { query: { lat: String(KINGSTON.lat), lng: String(KINGSTON.lng) } }, res
    ));
    assert.equal(res.statusCode, 500);
  });

  test('rejects a bad coordinate, radius or limit', async () => {
    for (const q of [
      {},
      { lat: '18' },
      { lng: '-76' },
      { lat: 'x', lng: '-76' },
      { lat: '91', lng: '-76' },
      { lat: '18', lng: '-181' },
      { lat: '18', lng: '-76', radius: 'far' },
      { lat: '18', lng: '-76', limit: '0' },
      { lat: '18', lng: '-76', limit: '2.5' },
      { lat: '18', lng: '-76', limit: 'many' },
    ]) {
      const calls = [];
      const res = makeRes();
      await handler({ calls })({ query: q }, res);
      assert.equal(res.statusCode, 400, JSON.stringify(q));
      assert.equal(calls.length, 0, JSON.stringify(q));
    }
  });

  test('clamps the radius to 50 m .. 50 km', async () => {
    for (const [radius, metres] of [['999999', 50000], ['1', 50]]) {
      const calls = [];
      await handler({ calls })({ query: { lat: '18.0179', lng: '-76.8099', radius } }, makeRes());
      const latSpan = calls[0].params[1] - calls[0].params[0];
      assert.ok(Math.abs(latSpan - (2 * metres) / 111000) < 1e-9, radius);
    }
  });

  test('a database failure is a 500, logged', async () => {
    const res = makeRes();
    await quiet(() => handler({ fail: true })({ query: { lat: '18', lng: '-76.8' } }, res));
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.success, false);
  });

  test('an unreadable dataset is a 500, logged', async () => {
    const res = makeRes();
    await quiet(() => handler({ loadDataset: () => { throw new Error('missing file'); } })(
      { query: { lat: '18', lng: '-76.8' } }, res
    ));
    assert.equal(res.statusCode, 500);
  });
});

describe('seedEmergencyShelters', () => {
  const dataset = {
    version: '2026-10-15T00:00:00.000Z',
    territories: TERRITORIES,
    shelters: Array.from({ length: 1001 }, (_, i) => ({
      type: 'node', id: i + 1, lat: 18, lon: -76.8, territory: 'JM',
      tags: { name: `School ${i}`, evacuation_center: 'yes' },
    })),
  };

  test('loads in batches, then removes rows from older versions', async () => {
    const calls = [];
    const result = await quiet(async () => {
      const original = console.log;
      console.log = () => {};
      try {
        return await shelters.seedEmergencyShelters(async (text, params) => {
          calls.push({ text, params });
          if (/COUNT/.test(text)) return { rows: [{ n: 0 }] };
          return { rows: [], rowCount: 0 };
        }, dataset);
      } finally {
        console.log = original;
      }
    });

    const inserts = calls.filter((c) => /INSERT INTO emergency_shelters/.test(c.text));
    assert.equal(inserts.length, 3, '500 + 500 + 1');
    assert.equal(inserts[0].params[0][0], 'node/1');
    assert.equal(inserts[0].params[3][0], 'JM');
    assert.equal(JSON.parse(inserts[0].params[4][0]).name, 'School 0');
    assert.equal(inserts[0].params[5], dataset.version);
    assert.equal(inserts[2].params[0].length, 1);
    assert.match(calls[calls.length - 1].text, /DELETE FROM emergency_shelters WHERE dataset_version <> \$1/);
    assert.equal(result.loaded, 1001);
  });

  test('does nothing when this version is already loaded', async () => {
    const calls = [];
    const original = console.log;
    console.log = () => {};
    try {
      const result = await shelters.seedEmergencyShelters(async (text) => {
        calls.push(text);
        return { rows: [{ n: 1001 }] };
      }, dataset);
      assert.equal(result.skipped, true);
      assert.equal(calls.length, 1);
    } finally {
      console.log = original;
    }
  });

  test('a database failure is reported, never thrown', async () => {
    const result = await quiet(() => shelters.seedEmergencyShelters(async () => { throw new Error('db down'); }, dataset));
    assert.equal(result.error, 'db down');
  });
});

describe('isDatasetLoaded', () => {
  const dataset = { version: 'v9', territories: TERRITORIES, shelters: [{}, {}, {}] };

  test('is true only when the table holds every row of this version', async () => {
    for (const [n, expected] of [[3, true], [2, false], [0, false]]) {
      const calls = [];
      const loaded = await shelters.isDatasetLoaded(async (text, params) => {
        calls.push({ text, params });
        return { rows: [{ n }] };
      }, dataset);
      assert.equal(loaded, expected, `${n} rows`);
      assert.deepEqual(calls[0].params, ['v9']);
      assert.match(calls[0].text, /FROM emergency_shelters WHERE dataset_version = \$1/);
    }
  });

  test('a database failure is thrown to the caller', async () => {
    await assert.rejects(shelters.isDatasetLoaded(async () => { throw new Error('db down'); }, dataset), /db down/);
  });
});

describe('shelters against Postgres', { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL to a throwaway database' }, () => {
  let pool;
  const q = (text, params) => pool.query(text, params);

  before(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL);
    Object.assign(process.env, {
      DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: url.pathname.slice(1),
      DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password),
    });
    delete process.env.DATABASE_URL;
    delete require.cache[require.resolve('../src/migrations/migrate')];
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
    await q('DELETE FROM emergency_shelters');
  });

  after(async () => {
    if (pool) {
      await q('DELETE FROM emergency_shelters');
      await pool.end();
    }
  });

  test('seeds the bundled dataset, finds Kingston shelters, then re-seeds a new version cleanly', async () => {
    const original = console.log;
    console.log = () => {};
    try {
      const data = shelters.loadDataset();
      const first = await shelters.seedEmergencyShelters(q, data);
      assert.equal(first.loaded, data.shelters.length);
      assert.equal((await q('SELECT COUNT(*)::int AS n FROM emergency_shelters')).rows[0].n, data.shelters.length);

      const again = await shelters.seedEmergencyShelters(q, data);
      assert.equal(again.skipped, true);

      const nearby = await shelters.findNearby(q, { latitude: KINGSTON.lat, longitude: KINGSTON.lng, radiusMeters: 30000, limit: 40 });
      assert.ok(nearby.length > 0, 'Kingston has mapped shelters');
      assert.ok(nearby.length <= 40);
      assert.equal(typeof nearby[0].tags, 'object');

      // A new version with one shelter left replaces everything else.
      const smaller = { ...data, version: 'test-v2', shelters: data.shelters.slice(0, 1) };
      await shelters.seedEmergencyShelters(q, smaller);
      const rows = (await q('SELECT osm_key, dataset_version FROM emergency_shelters')).rows;
      assert.deepEqual(rows, [{ osm_key: `${data.shelters[0].type}/${data.shelters[0].id}`, dataset_version: 'test-v2' }]);
    } finally {
      console.log = original;
    }
  });
});
