#!/usr/bin/env node
/**
 * End-to-end smoke test of the routes changed for the Dr. B fixes, run against
 * a real Postgres and a locally running API (never production).
 *
 *   DB_* and JWT_SECRET must match the running server; BASE defaults to
 *   http://localhost:5055/api/v1.
 */
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://localhost:5055/api/v1';
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '55432', 10),
  database: process.env.DB_NAME || 'caribwayz',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
});

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const call = async (method, path, token, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json };
};

const makeUser = async (name, email) => {
  const r = await pool.query(
    `INSERT INTO users (name, email, password_hash, auth_provider, role, status)
     VALUES ($1, $2, 'x', 'email', 'user', 'active') RETURNING id`,
    [name, email]
  );
  const id = r.rows[0].id;
  return { id, token: jwt.sign({ id, email, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
};

const openSocket = (token, groupId) => new Promise((resolve) => {
  const frames = [];
  const ws = new WebSocket(`${BASE.replace('http', 'ws').replace('/api/v1', '')}/ws/groups/location?token=${token}&group_id=${groupId}`);
  ws.on('message', (m) => frames.push(JSON.parse(m.toString())));
  ws.on('close', (code) => { ws.closeCode = code; });
  ws.on('open', () => setTimeout(() => resolve({ ws, frames }), 400));
  ws.on('error', () => resolve({ ws, frames }));
});

const main = async () => {
  const stamp = Date.now();
  const ada = await makeUser('Ada Smoke', `ada.${stamp}@example.com`);
  const ben = await makeUser('Ben Smoke', `ben.${stamp}@example.com`);
  const eve = await makeUser('Eve Outsider', `eve.${stamp}@example.com`);

  // Group: Ada creates, Ben joins.
  const created = await call('POST', '/groups', ada.token, {
    group_name: 'Smoke Run', destination_lat: 18.01, destination_lng: -76.79, destination_address: 'Kingston',
  });
  check('create group', created.status === 201 || created.status === 200, `status ${created.status}`);
  const group = created.json && (created.json.data.group || created.json.data);
  const groupId = group && group.id;
  const joinCode = group && group.join_code;
  const joined = await call('POST', '/groups/join', ben.token, { join_code: joinCode });
  check('join group', joined.status === 200 || joined.status === 201, `status ${joined.status}`);

  // Sockets: Ben (member) admitted; Eve (outsider) refused.
  const benSock = await openSocket(ben.token, groupId);
  check('member socket admitted', benSock.frames.some((f) => f.type === 'connected'));
  const eveSock = await openSocket(eve.token, groupId);
  await new Promise((r) => setTimeout(r, 300));
  check('outsider socket refused', eveSock.ws.closeCode === 4004, `close ${eveSock.ws.closeCode}`);

  // SOS from Ada reaches Ben live and as a notification.
  const sos = await call('POST', `/groups/${groupId}/sos`, ada.token, {
    latitude: 18.0179, longitude: -76.8099, raised_at: new Date().toISOString(), note: 'Flat tyre on Hope Road',
  });
  check('group SOS accepted', sos.status === 200, `status ${sos.status} ${JSON.stringify(sos.json && sos.json.data)}`);
  check('SOS delivered live to 1 member', sos.json && sos.json.data.delivered_live === 1);
  check('SOS saved as 1 notification', sos.json && sos.json.data.notified === 1);
  await new Promise((r) => setTimeout(r, 300));
  const sosFrame = benSock.frames.find((f) => f.type === 'sos');
  check('SOS frame reached member', !!sosFrame && sosFrame.user_name === 'Ada Smoke' && sosFrame.note === 'Flat tyre on Hope Road');

  // Check-in.
  const checkIn = await call('POST', `/groups/${groupId}/check-in`, ada.token, {
    checked_in: true, latitude: 18.0179, longitude: -76.8099, at: new Date().toISOString(),
  });
  check('check-in accepted', checkIn.status === 200, `status ${checkIn.status}`);
  check('check-in saved for 1 member', checkIn.json && checkIn.json.data.notified === 1);
  await new Promise((r) => setTimeout(r, 300));
  check('check-in frame reached member', benSock.frames.some((f) => f.type === 'check_in' && f.checked_in === true));
  const benNotes = await pool.query('SELECT title, type FROM notifications WHERE user_id = $1 ORDER BY created_at', [ben.id]);
  check('member has SOS and check-in notifications',
    benNotes.rows.length === 2 && benNotes.rows[0].type === 'emergency' && benNotes.rows[1].type === 'group',
    JSON.stringify(benNotes.rows));

  // Non-member SOS refused.
  const eveSos = await call('POST', `/groups/${groupId}/sos`, eve.token, { latitude: 18, longitude: -76.8 });
  check('outsider SOS refused', eveSos.status === 403, `status ${eveSos.status}`);

  // Delete: Ben (not creator) refused; Ada succeeds; Ben told live and by notification.
  const benDelete = await call('DELETE', `/groups/${groupId}`, ben.token);
  check('non-creator delete refused', benDelete.status === 403, `status ${benDelete.status}`);
  const adaDelete = await call('DELETE', `/groups/${groupId}`, ada.token);
  check('creator delete accepted', adaDelete.status === 200, `status ${adaDelete.status} ${JSON.stringify(adaDelete.json)}`);
  await new Promise((r) => setTimeout(r, 300));
  const deletedFrame = benSock.frames.find((f) => f.type === 'group_deleted');
  check('member told of deletion, with deleted_by', !!deletedFrame && deletedFrame.deleted_by === ada.id);
  const gone = await pool.query('SELECT 1 FROM groups WHERE id = $1', [groupId]);
  check('group row removed', gone.rows.length === 0);

  // Incident records: the table is created and records round-trip.
  const createRecord = await call('POST', '/records', ada.token, {
    severity: 'minor', type: 'accident', description: 'Smoke test record', location_text: 'Half Way Tree', reported_by: 'Ada',
  });
  check('create incident record', createRecord.status === 201 || createRecord.status === 200,
    `status ${createRecord.status} ${JSON.stringify(createRecord.json)}`);
  const listRecords = await call('GET', '/records', ada.token);
  check('list incident records', listRecords.status === 200, `status ${listRecords.status} ${JSON.stringify(listRecords.json).slice(0, 200)}`);

  // Reports: a reporter cannot confirm their own; another driver can.
  const report = await call('POST', '/reports', ada.token, {
    type: 'pothole', latitude: 18.0179, longitude: -76.8099, description: 'Pothole reported', severity: 'medium',
  });
  const reportId = report.json && report.json.data.report.id;
  const selfConfirm = await call('POST', `/reports/${reportId}/confirm`, ada.token);
  check('self-confirm refused', selfConfirm.status === 403, `status ${selfConfirm.status}`);
  const otherConfirm = await call('POST', `/reports/${reportId}/confirm`, ben.token);
  check('other driver confirms', otherConfirm.status === 200, `status ${otherConfirm.status}`);
  const nearby = await call('GET', '/reports/nearby?lat=18.0179&lng=-76.8099&radius=5', ben.token);
  check('nearby reports include it with user_id', nearby.status === 200 &&
    nearby.json.data.reports.some((r) => r.id === reportId && r.user_id === ada.id));

  // Roadside directory.
  const kingston = await call('GET', '/providers?key=roadside_mechanic&lat=18.0179&lng=-76.8099&radius=5000', ada.token);
  const els = (kingston.json && kingston.json.data.elements) || [];
  check('directory covers Kingston', kingston.status === 200 && kingston.json.data.covered === true && kingston.json.data.territory === 'JM');
  check('directory returns mechanics near Kingston', els.length > 0, `${els.length} places, first: ${els[0] && els[0].tags.name}`);
  const { haversineDistance } = require('../src/utils/haversine');
  const km = (e) => haversineDistance(18.0179, -76.8099, e.lat, e.lon);
  const sorted = els.every((e, i) => i === 0 || km(e) >= km(els[i - 1]) - 1e-9);
  check('directory results nearest first', sorted);
  const kolkata = await call('GET', '/providers?key=roadside_towing&lat=22.58&lng=88.47', ada.token);
  check('directory says not covered outside the Caribbean', kolkata.json && kolkata.json.data.covered === false);

  benSock.ws.close();
  eveSock.ws.close();
  await pool.end();
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch(async (err) => {
  console.error('Smoke test crashed:', err);
  await pool.end();
  process.exit(1);
});
