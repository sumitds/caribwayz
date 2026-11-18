'use strict';

// getRealtimeDB / getStorage must return null, not throw, when Firebase is
// initialised without FIREBASE_DATABASE_URL / FIREBASE_STORAGE_BUCKET. The
// live API runs that way: firebase-admin throws "Can't determine Firebase
// Database URL." from admin.database(), which turned every live-location
// update into a 500.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { generateKeyPairSync } = require('node:crypto');

// A throwaway key, escaped the way Render stores it (literal \n).
const FAKE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .replace(/\n/g, '\\n');

// Each case runs in a fresh process, because firebase-admin keeps one default
// app per process and initFirebase() caches its result.
const run = (env) => {
  const script = `
    const fb = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'config', 'firebase.js'))});
    const out = { init: fb.initFirebase() };
    try { out.db = fb.getRealtimeDB() === null ? 'null' : 'service'; } catch (e) { out.db = 'throws: ' + e.message; }
    try { out.storage = fb.getStorage() === null ? 'null' : 'bucket'; } catch (e) { out.storage = 'throws: ' + e.message; }
    process.stdout.write('@@RESULT@@' + JSON.stringify(out));
  `;
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith('FIREBASE_')) delete base[k];
  // initFirebase logs to stdout too, so the result follows a marker.
  const stdout = execFileSync(process.execPath, ['-e', script], { env: { ...base, ...env }, encoding: 'utf8' });
  return JSON.parse(stdout.split('@@RESULT@@').pop());
};

const CREDS = {
  FIREBASE_PROJECT_ID: 'caribwayz-test',
  FIREBASE_CLIENT_EMAIL: 'svc@caribwayz-test.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: FAKE_KEY,
};

test('no Firebase credentials: both getters return null', () => {
  assert.deepEqual(run({}), { init: false, db: 'null', storage: 'null' });
});

test('credentials without database URL or bucket: getters return null instead of throwing', () => {
  assert.deepEqual(run(CREDS), { init: true, db: 'null', storage: 'null' });
});

test('database URL and bucket set: getters return the services', () => {
  const out = run({
    ...CREDS,
    FIREBASE_DATABASE_URL: 'https://caribwayz-test-default-rtdb.firebaseio.com',
    FIREBASE_STORAGE_BUCKET: 'caribwayz-test.appspot.com',
  });
  assert.deepEqual(out, { init: true, db: 'service', storage: 'bucket' });
});
