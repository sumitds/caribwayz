import { useEffect, useRef, useCallback } from 'react';

const WS_BASE = (import.meta.env.VITE_API_BASE_URL || 'https://caribwayz-api-new.onrender.com')
  .replace(/^http/, 'ws');

/**
 * Subscribes to real-time location updates for all members of a group.
 *
 * @param {string|null} groupId  - UUID of the group (pass null to disconnect)
 * @param {function}    onUpdate - called with { user_id, user_name, current_latitude, current_longitude, timestamp }
 */
export function useGroupLocation(groupId, onUpdate) {
  const wsRef     = useRef(null);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  const connect = useCallback(() => {
    if (!groupId) return;

    const token = localStorage.getItem('cw_token');
    if (!token) return;

    const url = `${WS_BASE}/ws/groups/location?token=${token}&group_id=${groupId}`;
    const ws  = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log(`[WS] Connected to group ${groupId}`);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'location_update') {
          onUpdateRef.current(data);
        }
      } catch {}
    };

    ws.onclose = (e) => {
      console.log(`[WS] Disconnected (${e.code})`);
      // Auto-reconnect after 3s unless intentionally closed
      if (e.code !== 1000 && e.code !== 4001 && e.code !== 4003) {
        setTimeout(connect, 3000);
      }
    };

    ws.onerror = (err) => {
      console.error('[WS] Error:', err);
    };
  }, [groupId]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close(1000, 'component unmounted');
    };
  }, [connect]);
}
