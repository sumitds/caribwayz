const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Group sockets must accept every token the API issues. When JWT_SECRET is
// unset, utils/jwt signs with a per-process fallback key; a socket that
// verified with process.env.JWT_SECRET instead refused every such token.
// Runs in a child process so the unset key cannot leak into other tests.
const CHILD = `
const http = require('node:http');
const WebSocket = require('ws');
const { generateToken } = require(${JSON.stringify(path.join(__dirname, '../src/utils/jwt'))});
const { initWebSocket } = require(${JSON.stringify(path.join(__dirname, '../src/services/wsService'))});
const server = http.createServer();
initWebSocket(server, { isSessionActive: async () => true });
server.listen(0, () => {
  const { port } = server.address();
  const token = generateToken({ id: '11111111-1111-4111-8111-111111111111', sid: '22222222-2222-4222-8222-222222222222' });
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws/groups/location?token=' + token
    + '&group_id=33333333-3333-4333-8333-333333333333');
  const finish = (code, reason) => {
    process.stdout.write('\\nRESULT ' + JSON.stringify({ code, reason: String(reason) }) + '\\n');
    process.exit(0);
  };
  ws.on('close', finish);
  ws.on('open', () => setTimeout(() => finish('open', ''), 300));
  ws.on('error', () => {});
  setTimeout(() => finish('timeout', ''), 5000);
});
`;

test('a socket accepts a token signed with the fallback key when JWT_SECRET is unset', () => {
  const env = { ...process.env, NODE_ENV: 'test' };
  delete env.JWT_SECRET;
  delete env.DATABASE_URL;
  const run = spawnSync(process.execPath, ['-e', CHILD], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0, run.stderr);
  const line = run.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `no result from the child process:\n${run.stdout}\n${run.stderr}`);
  const result = JSON.parse(line.slice('RESULT '.length));
  assert.notEqual(result.reason, 'Invalid or expired token', 'the socket refused a token the API issued');
});
