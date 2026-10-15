const { WebSocketServer } = require('ws');
const { verifyToken } = require('../utils/jwt');
const url = require('url');
const { onSessionsRevoked } = require('./sessionService');

// groupRooms: Map<groupId, Map<userId, WebSocket>>
const groupRooms = new Map();

// sessionSockets: Map<sessionId, Set<WebSocket>>, the open sockets of each
// sign-in session, so signing a session out closes them too.
const sessionSockets = new Map();

/** Close code for a socket whose session was signed out. */
const WS_SIGNED_OUT = 4003;

/** Remembers that [ws] belongs to [sessionId] until it closes. */
function trackSessionSocket(sessionId, ws) {
  if (!sessionSockets.has(sessionId)) sessionSockets.set(sessionId, new Set());
  sessionSockets.get(sessionId).add(ws);
  ws.on('close', () => {
    const sockets = sessionSockets.get(sessionId);
    if (!sockets) return;
    sockets.delete(ws);
    if (sockets.size === 0) sessionSockets.delete(sessionId);
  });
}

/**
 * Closes every open socket of the given sessions. Called when they are
 * signed out (logout, signing out other devices, a password reset or
 * change). Returns how many sockets were closed.
 */
function closeSessionSockets(sessionIds) {
  let closed = 0;
  for (const sessionId of sessionIds) {
    const sockets = sessionSockets.get(sessionId);
    if (!sockets) continue;
    sessionSockets.delete(sessionId);
    for (const ws of sockets) {
      try {
        ws.close(WS_SIGNED_OUT, 'Signed out');
        closed++;
      } catch (err) {
        console.error(`WS: closing a signed-out socket failed (session ${sessionId}):`, err.message);
      }
    }
  }
  return closed;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether userId is an active member of groupId.
 *
 * A room carries members' live positions and, in SOS frames, where someone in
 * distress is. A valid login alone used to be enough to join any group's room
 * by guessing or reusing its id.
 *
 * queryFn is injectable for tests; it defaults to the shared pool. Throws when
 * the database cannot be asked, so the caller can tell that apart from "no".
 */
async function isActiveMember(groupId, userId, queryFn) {
  if (!UUID_PATTERN.test(String(groupId)) || !userId) return false;
  const run = queryFn || require('../config/db').query;
  const result = await run(
    `SELECT 1 FROM group_members
      WHERE group_id = $1 AND user_id = $2 AND status = 'active'`,
    [groupId, userId]
  );
  return result.rows.length > 0;
}

/**
 * [options] are for tests: isSessionActive({sessionId, userId}) and the
 * membership queryFn default to the shared session service and pool.
 */
function initWebSocket(server, options = {}) {
  const checkSession = options.isSessionActive
    || ((args) => require('./sessionService').sessionService().isSessionActive(args));
  const wss = new WebSocketServer({ server, path: '/ws/groups/location' });
  const stopListening = onSessionsRevoked(closeSessionSockets);
  wss.on('close', stopListening);

  wss.on('connection', (ws, req) => {
    const { query } = url.parse(req.url, true);
    const token   = query.token;
    const groupId = query.group_id;

    // Auth check
    if (!token || !groupId) {
      ws.close(4001, 'token and group_id query params are required');
      return;
    }

    let userId;
    let sessionId;
    try {
      // The same key the API signs with, including its fallback when
      // JWT_SECRET is unset, so sockets accept every token the API issues.
      const decoded = verifyToken(token);
      userId = decoded.id || decoded.userId || decoded.sub;
      sessionId = decoded.sid;
    } catch {
      ws.close(4003, 'Invalid or expired token');
      return;
    }

    ws.on('error', (err) => {
      console.error(`WS error for user ${userId}:`, err.message);
    });

    // As middleware/auth.js does for HTTP: a token must name its session, and
    // is refused once that session has been signed out. One without a sid
    // could never be signed out, so it gets the signed-out close code.
    if (sessionId === undefined) {
      ws.close(WS_SIGNED_OUT, 'Invalid or expired token');
      return;
    }

    checkSession({ sessionId, userId })
      .then(async (active) => {
        if (!active) {
          ws.close(WS_SIGNED_OUT, 'Invalid or expired token');
          return;
        }
        // Tracked before the membership check, so a sign-out that lands
        // while it runs still closes this socket.
        trackSessionSocket(sessionId, ws);
        const member = await isActiveMember(groupId, userId, options.queryFn);
        if (!member) {
          ws.close(4004, 'Not a member of this group');
          return;
        }
        // The client may have gone while membership was checked.
        if (ws.readyState !== WS_OPEN) return;
        joinRoom(ws, groupId, userId);
      })
      .catch((err) => {
        console.error(`WS session or membership check failed for user ${userId}, group ${groupId}:`, err.message);
        ws.close(1011, 'Could not verify group membership');
      });
  });

  console.log('WebSocket server initialised at /ws/groups/location');
  return wss;
}

/** Registers ws in the room and confirms it to the client. */
function joinRoom(ws, groupId, userId) {
    if (!groupRooms.has(groupId)) groupRooms.set(groupId, new Map());
    groupRooms.get(groupId).set(userId, ws);

    console.log(`WS: user ${userId} joined group ${groupId} (room size: ${groupRooms.get(groupId).size})`);

    // Send confirmation
    ws.send(JSON.stringify({ type: 'connected', group_id: groupId, user_id: userId }));

    ws.on('close', () => {
      const room = groupRooms.get(groupId);
      if (room) {
        room.delete(userId);
        if (room.size === 0) groupRooms.delete(groupId);
      }
      console.log(`WS: user ${userId} left group ${groupId}`);
    });
}

const WS_OPEN = 1;

/**
 * Sends one JSON frame to every OPEN socket in a group's room.
 *
 * This server never relays client messages, so every group event (location,
 * SOS, check-in, deletion) reaches other members only through this function,
 * called from the REST handler that accepted the event.
 *
 * A socket whose send throws is logged and skipped: one broken connection must
 * not stop an SOS from reaching the rest of the group.
 *
 * [excludeUserIds] are members who must not get this frame: people who have
 * blocked the sender or whom the sender blocked (services/blockService.js).
 *
 * Returns the number of sockets the frame was handed to.
 */
function broadcastToGroup(groupId, payloadObject, excludeUserIds = []) {
  const room = groupRooms.get(groupId);
  if (!room) return 0;

  const payload = JSON.stringify(payloadObject);
  const excluded = new Set(excludeUserIds.map((id) => String(id).toLowerCase()));
  let sent = 0;

  for (const [memberId, socket] of room.entries()) {
    if (socket.readyState !== WS_OPEN) continue;
    if (excluded.has(String(memberId).toLowerCase())) continue;
    try {
      socket.send(payload);
      sent++;
    } catch (err) {
      console.error(
        `WS: send of ${payloadObject && payloadObject.type} to user ${memberId} in group ${groupId} failed:`,
        err.message
      );
    }
  }

  return sent;
}

/**
 * Whether [userId] currently holds an OPEN socket in [groupId]'s room.
 *
 * Lets a caller report how many OTHER members a broadcast reached, since the
 * sender's own socket receives every frame too.
 */
function isMemberConnected(groupId, userId) {
  const room = groupRooms.get(groupId);
  if (!room) return false;
  const socket = room.get(userId);
  return Boolean(socket) && socket.readyState === WS_OPEN;
}

// Called by POST /groups/:id/location after Firebase update. [excludeUserIds]
// are the members in a block with the sender, who must not see where they are.
function broadcastLocation(groupId, userId, userName, latitude, longitude, excludeUserIds = []) {
  return broadcastToGroup(groupId, {
    type: 'location_update',
    user_id: userId,
    user_name: userName,
    current_latitude: latitude,
    current_longitude: longitude,
    timestamp: Date.now(),
  }, excludeUserIds);
}

// groupRooms is exported so tests can register fake sockets; production code
// only mutates it through initWebSocket's connection handlers.
module.exports = {
  initWebSocket, broadcastLocation, broadcastToGroup, isMemberConnected, isActiveMember, groupRooms,
  trackSessionSocket, closeSessionSockets, sessionSockets,
};
