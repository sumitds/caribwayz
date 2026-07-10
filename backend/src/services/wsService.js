const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const url = require('url');

// groupRooms: Map<groupId, Map<userId, WebSocket>>
const groupRooms = new Map();

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

    // Register in room
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

    ws.on('error', (err) => {
      console.error(`WS error for user ${userId}:`, err.message);
    });
  });

  console.log('WebSocket server initialised at /ws/groups/location');
  return wss;
}

// Called by POST /groups/:id/location after Firebase update
function broadcastLocation(groupId, userId, userName, latitude, longitude) {
  const room = groupRooms.get(groupId);
  if (!room) return;

  const payload = JSON.stringify({
    type: 'location_update',
    user_id: userId,
    user_name: userName,
    current_latitude: latitude,
    current_longitude: longitude,
    timestamp: Date.now(),
  });

  for (const [memberId, socket] of room.entries()) {
    if (socket.readyState === 1) { // OPEN
      socket.send(payload);
    }
  }
}

module.exports = { initWebSocket, broadcastLocation };
