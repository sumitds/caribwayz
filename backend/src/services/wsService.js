const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const url = require('url');

// groupRooms: Map<groupId, Map<userId, WebSocket>>
const groupRooms = new Map();

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

function initWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws/groups/location' });

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
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      userId = decoded.id || decoded.userId || decoded.sub;
    } catch {
      ws.close(4003, 'Invalid or expired token');
      return;
    }

    ws.on('error', (err) => {
      console.error(`WS error for user ${userId}:`, err.message);
    });

    isActiveMember(groupId, userId)
      .then((member) => {
        if (!member) {
          ws.close(4004, 'Not a member of this group');
          return;
        }
        // The client may have gone while membership was checked.
        if (ws.readyState !== WS_OPEN) return;
        joinRoom(ws, groupId, userId);
      })
      .catch((err) => {
        console.error(`WS membership check failed for user ${userId}, group ${groupId}:`, err.message);
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
 * Returns the number of sockets the frame was handed to.
 */
function broadcastToGroup(groupId, payloadObject) {
  const room = groupRooms.get(groupId);
  if (!room) return 0;

  const payload = JSON.stringify(payloadObject);
  let sent = 0;

  for (const [memberId, socket] of room.entries()) {
    if (socket.readyState !== WS_OPEN) continue;
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

// Called by POST /groups/:id/location after Firebase update
function broadcastLocation(groupId, userId, userName, latitude, longitude) {
  return broadcastToGroup(groupId, {
    type: 'location_update',
    user_id: userId,
    user_name: userName,
    current_latitude: latitude,
    current_longitude: longitude,
    timestamp: Date.now(),
  });
}

// groupRooms is exported so tests can register fake sockets; production code
// only mutates it through initWebSocket's connection handlers.
module.exports = { initWebSocket, broadcastLocation, broadcastToGroup, isMemberConnected, isActiveMember, groupRooms };
