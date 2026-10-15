// Three gaps in the group routes:
//  - GET /groups/:id answered anyone signed in, so a group id was enough to
//    read every member's last known location;
//  - POST /groups/:id/location read latitude/longitude while the app sends
//    current_latitude/current_longitude, so live frames carried no position;
//  - an invite went out as one email with every address on its To: line.
//
// groupController takes the database and the socket layer when it loads, so it
// is loaded fresh against fakes here.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const GROUP_ID = '6f1c2b9e-3d4a-4c5b-8e7f-0a1b2c3d4e5f';
const ME = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const ADMIN = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const src = (mod) => require.resolve(path.join(__dirname, '../src', mod));

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

/**
 * groupController over a fake database ([member] decides whether the caller
 * is an active member) and a fake socket layer recording location frames.
 */
const loadController = ({ member = true, sendGroupInvite = async () => 1 } = {}) => {
  const calls = [];
  const frames = [];
  const query = async (text, params) => {
    calls.push({ text, params });
    if (/SELECT \* FROM groups WHERE id = \$1/.test(text)) {
      return { rows: [{ id: GROUP_ID, group_name: 'Beach Run', join_code: 'AB12CD' }], rowCount: 1 };
    }
    if (/FROM users u\s+WHERE LOWER\(u\.email\)/.test(text)) return { rows: [], rowCount: 0 };
    if (/FROM group_members gm\s+JOIN users u ON gm\.user_id = u\.id/.test(text)) {
      return { rows: [{ user_id: ME, current_latitude: 10, current_longitude: -61 }], rowCount: 1 };
    }
    if (/FROM group_members/.test(text) && /gm\.user_id = \$2|user_id = \$2/.test(text)) {
      return member
        ? { rows: [{ id: 'm1', user_name: 'Asha', blocked_with: [] }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    throw new Error(`Unexpected SQL in test: ${text}`);
  };

  const fakes = {
    'config/db': { query, getClient: async () => { throw new Error('no client'); }, pool: null },
    'config/firebase': { getRealtimeDB: () => null, getMessaging: () => null, getStorage: () => null },
    'services/wsService': {
      broadcastLocation: (...args) => { frames.push(args); return 1; },
      broadcastToGroup: () => 0,
      isMemberConnected: () => false,
    },
    'services/emailService': { sendGroupInvite },
  };
  const originals = {};
  for (const [mod, exports] of Object.entries(fakes)) {
    const p = src(mod);
    originals[p] = require.cache[p];
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  }
  const controllerPath = src('controllers/groupController');
  const originalController = require.cache[controllerPath];
  delete require.cache[controllerPath];
  try {
    return { controller: require(controllerPath), calls, frames };
  } finally {
    for (const [p, original] of Object.entries(originals)) {
      if (original) require.cache[p] = original; else delete require.cache[p];
    }
    if (originalController) require.cache[controllerPath] = originalController; else delete require.cache[controllerPath];
  }
};

const req = ({ id = GROUP_ID, body = {}, userId = ME, role = 'user' } = {}) => ({
  params: { id }, body, user: { id: userId, email: 'x@example.com', role },
});

describe('GET /groups/:id', () => {
  test('a member gets the group and its members', async () => {
    const { controller } = loadController({ member: true });
    const res = makeRes();
    await controller.getGroupDetails(req(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.members.length, 1);
  });

  test('someone outside the group is refused and sees no member', async () => {
    const { controller, calls } = loadController({ member: false });
    const res = makeRes();
    await controller.getGroupDetails(req(), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.data, undefined);
    assert.ok(!calls.some((c) => /JOIN users u ON gm\.user_id = u\.id/.test(c.text)), 'members were never read');
  });

  test('an admin may look at any group', async () => {
    const { controller } = loadController({ member: false });
    const res = makeRes();
    await controller.getGroupDetails(req({ userId: ADMIN, role: 'admin' }), res);
    assert.equal(res.statusCode, 200);
  });

  test('an id that is not a UUID is a 400, not a database error', async () => {
    const { controller, calls } = loadController();
    const res = makeRes();
    await controller.getGroupDetails(req({ id: 'not-a-uuid' }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  });
});

describe('POST /groups/:id/location', () => {
  const send = async (body, opts) => {
    const { controller, frames } = loadController(opts);
    const res = makeRes();
    await controller.updateLocation(req({ body }), res);
    return { res, frames };
  };

  test('takes current_latitude/current_longitude, which is what the app sends', async () => {
    const { res, frames } = await send({ current_latitude: 10.6918, current_longitude: -61.2225 });
    assert.equal(res.statusCode, 200);
    assert.equal(frames.length, 1);
    assert.equal(frames[0][3], 10.6918);
    assert.equal(frames[0][4], -61.2225);
  });

  test('still takes latitude/longitude, and numeric strings', async () => {
    const { frames } = await send({ latitude: '18.01', longitude: '-76.79' });
    assert.equal(frames[0][3], 18.01);
    assert.equal(frames[0][4], -76.79);
  });

  test('refuses a missing, partial or out-of-range position without broadcasting', async () => {
    for (const body of [
      {},
      { current_latitude: 10 },
      { current_latitude: 91, current_longitude: 0 },
      { latitude: 0, longitude: -181 },
      { latitude: 'north', longitude: 1 },
      { latitude: true, longitude: 1 },
    ]) {
      const { res, frames } = await send(body);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.equal(frames.length, 0, JSON.stringify(body));
    }
  });

  test('a non-member is refused', async () => {
    const { res, frames } = await send({ current_latitude: 1, current_longitude: 1 }, { member: false });
    assert.equal(res.statusCode, 403);
    assert.equal(frames.length, 0);
  });

  test('an id that is not a UUID is a 400', async () => {
    const { controller } = loadController();
    const res = makeRes();
    await controller.updateLocation(req({ id: 'x', body: { latitude: 1, longitude: 1 } }), res);
    assert.equal(res.statusCode, 400);
  });
});

describe('group invite email', () => {
  const loadWithMailer = (sendMail) => {
    const nodemailerPath = require.resolve('nodemailer');
    const servicePath = src('services/emailService');
    const original = require.cache[nodemailerPath];
    delete require.cache[servicePath];
    require.cache[nodemailerPath] = {
      id: nodemailerPath, filename: nodemailerPath, loaded: true,
      exports: { createTransport: () => ({ sendMail }) },
    };
    try {
      return require(servicePath);
    } finally {
      if (original) require.cache[nodemailerPath] = original; else delete require.cache[nodemailerPath];
      delete require.cache[servicePath];
    }
  };

  const invite = { groupName: 'Beach Run', joinCode: 'AB12CD', inviterName: 'Asha' };

  test('each recipient gets their own email and sees no other address', async () => {
    const sent = [];
    const { sendGroupInvite } = loadWithMailer(async (mail) => { sent.push(mail); });
    const count = await sendGroupInvite({ ...invite, toEmails: ['a@example.com', 'b@example.com', 'c@example.com'] });

    assert.equal(count, 3);
    assert.deepEqual(sent.map((m) => m.to), ['a@example.com', 'b@example.com', 'c@example.com']);
    for (const mail of sent) {
      assert.equal(mail.cc, undefined);
      assert.equal(mail.bcc, undefined);
      const others = ['a@example.com', 'b@example.com', 'c@example.com'].filter((a) => a !== mail.to);
      for (const other of others) {
        assert.ok(!JSON.stringify(mail).includes(other), `${mail.to}'s email names ${other}`);
      }
    }
  });

  test('one failed address does not stop the others, and the failure is raised', async () => {
    const sent = [];
    const { sendGroupInvite } = loadWithMailer(async (mail) => {
      if (mail.to === 'b@example.com') throw Object.assign(new Error('mailbox unavailable'), { code: 'EENVELOPE' });
      sent.push(mail.to);
    });
    await assert.rejects(
      sendGroupInvite({ ...invite, toEmails: ['a@example.com', 'b@example.com', 'c@example.com'] }),
      (err) => {
        assert.match(err.message, /1 of 3 invitations could not be sent/);
        assert.match(err.message, /mailbox unavailable/);
        assert.equal(err.code, 'EENVELOPE');
        assert.equal(err.sent, 2);
        return true;
      }
    );
    assert.deepEqual(sent, ['a@example.com', 'c@example.com']);
  });

  test('sends at most two at a time, and every address still gets its email', async () => {
    let inFlight = 0;
    let most = 0;
    const sent = [];
    const { sendGroupInvite } = loadWithMailer(async (mail) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      sent.push(mail.to);
      inFlight -= 1;
    });
    const toEmails = Array.from({ length: 10 }, (_, i) => `p${i}@example.com`);
    assert.equal(await sendGroupInvite({ ...invite, toEmails }), 10);
    assert.equal(most, 2);
    assert.deepEqual([...sent].sort(), [...toEmails].sort());
  });

  test('an address carrying a header break is refused before anything is sent', async () => {
    const sent = [];
    const { sendGroupInvite } = loadWithMailer(async (mail) => { sent.push(mail); });
    await assert.rejects(sendGroupInvite({ ...invite, toEmails: ['a@example.com', 'b@example.com\r\nBcc: x@example.com'] }));
    assert.equal(sent.length, 0);
  });
});

describe('POST /groups/:id/invite when mail fails', () => {
  const inviteWith = async (failure) => {
    const { controller } = loadController({ sendGroupInvite: async () => { throw failure; } });
    const res = makeRes();
    const logged = [];
    const original = console.error;
    console.error = (...a) => logged.push(a.join(' '));
    try {
      await controller.inviteToGroup(req({ body: { email: ['a@example.com', 'b@example.com'] } }), res);
    } finally {
      console.error = original;
    }
    res.logged = logged;
    return res;
  };

  test('a partial failure says so without counting addresses', async () => {
    const res = await inviteWith(Object.assign(new Error('1 of 2 invitations could not be sent: bounced'), { detail: 'bounced', sent: 1 }));
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, 'Some invitations could not be sent. Please try again.');
  });

  test('a total failure says so plainly, never echoing the mail server, and is logged without addresses', async () => {
    const smtp = '550 5.1.1 <b@example.com>: Recipient address rejected: User unknown in virtual mailbox table';
    const res = await inviteWith(Object.assign(new Error(`2 of 2 invitations could not be sent: ${smtp}`), { code: 'EENVELOPE', detail: smtp, sent: 0 }));
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, 'The invitations could not be sent. Please try again.');
    assert.ok(res.logged.some((l) => l.includes('EENVELOPE') && l.includes('Recipient address rejected')), 'the reason is logged');
    assert.ok(res.logged.every((l) => !l.includes('@example.com')), 'no address is logged');
  });

  test('missing mail credentials are named as such', async () => {
    const res = await inviteWith(Object.assign(new Error('2 of 2 invitations could not be sent: Invalid login'), { code: 'EAUTH', detail: 'Invalid login', sent: 0 }));
    assert.match(res.body.message, /Email service not configured/);
  });
});
