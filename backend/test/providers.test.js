// Covers the CaribWayz roadside directory behind the Services lists.
//
// The lists used to ask the public Overpass servers live; when those were busy
// or down, a stranded driver saw "Could not load". The directory serves the
// same OpenStreetMap places from CaribWayz's own database.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const roadside = require('../src/services/roadsidePlaces');
const { buildProviderHandlers } = require('../src/controllers/providerController');

const TERRITORIES = { JM: [17.65, -78.45, 18.6, -76.15], BB: [13.0, -59.7, 13.35, -59.4] };
const KINGSTON = { lat: 18.0179, lng: -76.8099 };

const makeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

const handler = ({ rows = [], fail = false, calls = [] } = {}) =>
  buildProviderHandlers({
    query: async (text, params) => {
      calls.push({ text, params });
      if (fail) throw new Error('db down');
      return { rows };
    },
    loadDataset: () => ({ version: 'v1', territories: TERRITORIES, places: [] }),
    findNearby: roadside.findNearby,
  }).getProviders;

const quiet = async (fn) => {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
};

describe('territoryFor', () => {
  test('finds the territory a point is in, and null outside them all', () => {
    assert.equal(roadside.territoryFor(KINGSTON.lat, KINGSTON.lng, TERRITORIES), 'JM');
    assert.equal(roadside.territoryFor(13.1, -59.6, TERRITORIES), 'BB');
    assert.equal(roadside.territoryFor(22.58, 88.47, TERRITORIES), null);
  });
});

describe('LOOKUP_KINDS', () => {
  test('covers every Services lookup key the app sends', () => {
    assert.deepEqual(Object.keys(roadside.LOOKUP_KINDS).sort(), [
      'roadside_battery', 'roadside_fuel', 'roadside_locksmith', 'roadside_mechanic',
      'roadside_overheating', 'roadside_towing', 'roadside_tyres', 'roadside_winch',
    ]);
  });
});

describe('GET /providers', () => {
  test('returns nearby places nearest first, shaped like Overpass elements', async () => {
    const calls = [];
    const rows = [
      { osm_key: 'node/2', latitude: 18.06, longitude: -76.81, tags: { name: 'Far Garage', shop: 'car_repair' } },
      { osm_key: 'way/1', latitude: '18.0185', longitude: '-76.8099', tags: { name: 'Near Garage', shop: 'car_repair' } },
      // Inside the pre-filter box but beyond the radius: dropped.
      { osm_key: 'node/3', latitude: 18.0179, longitude: -76.75, tags: { name: 'Corner Garage' } },
    ];
    const res = makeRes();
    await handler({ rows, calls })(
      { query: { key: 'roadside_mechanic', lat: String(KINGSTON.lat), lng: String(KINGSTON.lng), radius: '5000' } },
      res
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.covered, true);
    assert.equal(res.body.data.territory, 'JM');
    assert.deepEqual(res.body.data.elements.map((e) => e.tags.name), ['Near Garage', 'Far Garage']);
    assert.deepEqual(res.body.data.elements[0], {
      type: 'way', id: 1, lat: 18.0185, lon: -76.8099, tags: { name: 'Near Garage', shop: 'car_repair' },
    });
    assert.deepEqual(calls[0].params[4], ['car_repair'], 'only the kinds for this lookup');
  });

  test('outside every covered territory, says so and does not query', async () => {
    const calls = [];
    const res = makeRes();
    await handler({ calls })({ query: { key: 'roadside_towing', lat: '22.58', lng: '88.47' } }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data, { covered: false, territory: null, elements: [] });
    assert.equal(calls.length, 0);
  });

  test('an empty answer inside a territory is a real "nothing nearby"', async () => {
    const res = makeRes();
    await handler({ rows: [] })({ query: { key: 'roadside_locksmith', lat: '13.1', lng: '-59.6' } }, res);
    assert.equal(res.body.data.covered, true);
    assert.deepEqual(res.body.data.elements, []);
  });

  test('rejects an unknown key and a bad coordinate', async () => {
    for (const q of [
      { key: 'pizza', lat: '18', lng: '-76' },
      { lat: '18', lng: '-76' },
      { key: 'roadside_fuel', lat: 'x', lng: '-76' },
      { key: 'roadside_fuel', lat: '91', lng: '-76' },
      { key: 'roadside_fuel', lng: '-76' },
      { key: 'roadside_fuel', lat: '18', lng: '-76', radius: 'far' },
      { key: '__proto__', lat: '18', lng: '-76' },
    ]) {
      const res = makeRes();
      await handler()({ query: q }, res);
      assert.equal(res.statusCode, 400, JSON.stringify(q));
    }
  });

  test('clamps the radius to 50 m .. 50 km', async () => {
    const calls = [];
    await handler({ calls })({ query: { key: 'roadside_fuel', lat: '18.0179', lng: '-76.8099', radius: '999999' } }, makeRes());
    const latSpan = calls[0].params[1] - calls[0].params[0];
    assert.ok(Math.abs(latSpan - (2 * 50000) / 111000) < 1e-9);
  });

  test('a database failure is a 500, logged', async () => {
    const res = makeRes();
    await quiet(() => handler({ fail: true })({ query: { key: 'roadside_fuel', lat: '18', lng: '-76.8' } }, res));
    assert.equal(res.statusCode, 500);
  });
});

describe('seedRoadsidePlaces', () => {
  const dataset = {
    version: '2026-10-03T00:00:00.000Z',
    territories: TERRITORIES,
    places: Array.from({ length: 1201 }, (_, i) => ({
      type: 'node', id: i + 1, lat: 18, lon: -76.8, territory: 'JM',
      kinds: ['car_repair', 'tyres'], tags: { name: `Garage ${i}` },
    })),
  };

  test('loads in batches, then removes rows from older versions', async () => {
    const calls = [];
    const result = await quiet(() => roadside.seedRoadsidePlaces(async (text, params) => {
      calls.push({ text, params });
      if (/COUNT/.test(text)) return { rows: [{ n: 0 }] };
      return { rows: [], rowCount: 0 };
    }, dataset));

    const inserts = calls.filter((c) => /INSERT INTO roadside_places/.test(c.text));
    assert.equal(inserts.length, 3, '500 + 500 + 201');
    assert.equal(inserts[0].params[0][0], 'node/1');
    assert.equal(inserts[0].params[4][0], 'car_repair,tyres');
    assert.equal(JSON.parse(inserts[0].params[5][0]).name, 'Garage 0');
    assert.equal(inserts[2].params[0].length, 201);
    assert.match(calls[calls.length - 1].text, /DELETE FROM roadside_places WHERE dataset_version <> \$1/);
    assert.equal(result.loaded, 1201);
  });

  test('does nothing when this version is already loaded', async () => {
    const calls = [];
    const original = console.log;
    console.log = () => {};
    try {
      const result = await roadside.seedRoadsidePlaces(async (text) => {
        calls.push(text);
        return { rows: [{ n: 1201 }] };
      }, dataset);
      assert.equal(result.skipped, true);
      assert.equal(calls.length, 1);
    } finally {
      console.log = original;
    }
  });

  test('a database failure is reported, never thrown', async () => {
    const result = await quiet(() => roadside.seedRoadsidePlaces(async () => { throw new Error('db down'); }, dataset));
    assert.equal(result.error, 'db down');
  });
});
