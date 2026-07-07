const { query } = require('../config/db');
const { haversineDistance, estimateETA } = require('../utils/haversine');
const { success, created, error, notFound } = require('../utils/response');

/**
 * Fetch optimized route data from Google Directions API.
 * Falls back to Haversine if API key is not set or the call fails.
 */
const getGoogleDirections = async (originLat, originLng, destLat, destLng) => {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key || key === 'your_google_maps_api_key_here') return null;

  try {
    const url =
      `https://maps.googleapis.com/maps/api/directions/json` +
      `?origin=${originLat},${originLng}` +
      `&destination=${destLat},${destLng}` +
      `&key=${key}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== 'OK' || !data.routes?.[0]) return null;

    const leg = data.routes[0].legs[0];
    return {
      distance: parseFloat((leg.distance.value / 1000).toFixed(2)), // km
      eta: Math.round(leg.duration.value / 60),                      // minutes
      polyline: data.routes[0].overview_polyline.points,
    };
  } catch (err) {
    console.warn('[Google Directions] API call failed:', err.message);
    return null;
  }
};

const createRoute = async (req, res) => {
  try {
    const { route_name, start_lat, start_lng, start_address, end_lat, end_lng, end_address, stops } = req.body;

    // Try Google Directions first; fall back to Haversine
    const directions = await getGoogleDirections(start_lat, start_lng, end_lat, end_lng);
    const distance = directions?.distance ?? parseFloat(haversineDistance(
      parseFloat(start_lat), parseFloat(start_lng),
      parseFloat(end_lat), parseFloat(end_lng)
    ).toFixed(2));
    const eta = directions?.eta ?? estimateETA(distance);
    const polyline = directions?.polyline ?? null;

    const routeResult = await query(
      `INSERT INTO routes (user_id, route_name, start_lat, start_lng, start_address, end_lat, end_lng, end_address, distance, eta, polyline)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [req.user.id, route_name, start_lat, start_lng, start_address, end_lat, end_lng, end_address,
       distance, eta, polyline]
    );

    const route = routeResult.rows[0];

    if (stops && stops.length > 0) {
      for (let i = 0; i < stops.length; i++) {
        const s = stops[i];
        await query(
          `INSERT INTO route_stops (route_id, stop_name, latitude, longitude, sequence_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [route.id, s.stop_name, s.latitude, s.longitude, i + 1]
        );
      }
    }

    return created(res, { route }, 'Route created successfully');
  } catch (err) {
    console.error('Create route error:', err);
    return error(res, 'Failed to create route', 500);
  }
};

const getRoutes = async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM routes WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    return success(res, { routes: result.rows });
  } catch (err) {
    console.error('Get routes error:', err);
    return error(res, 'Failed to fetch routes', 500);
  }
};

const getRouteById = async (req, res) => {
  try {
    const { id } = req.params;
    const routeResult = await query('SELECT * FROM routes WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (routeResult.rows.length === 0) return notFound(res, 'Route not found');

    const stopsResult = await query(
      'SELECT * FROM route_stops WHERE route_id = $1 ORDER BY sequence_order',
      [id]
    );

    return success(res, { route: routeResult.rows[0], stops: stopsResult.rows });
  } catch (err) {
    console.error('Get route error:', err);
    return error(res, 'Failed to fetch route', 500);
  }
};

const updateRoute = async (req, res) => {
  try {
    const { id } = req.params;
    const { route_name, status } = req.body;

    const result = await query(
      `UPDATE routes SET route_name = COALESCE($1, route_name), status = COALESCE($2, status), updated_at = NOW()
       WHERE id = $3 AND user_id = $4 RETURNING *`,
      [route_name, status, id, req.user.id]
    );
    if (result.rows.length === 0) return notFound(res, 'Route not found');
    return success(res, { route: result.rows[0] }, 'Route updated');
  } catch (err) {
    console.error('Update route error:', err);
    return error(res, 'Failed to update route', 500);
  }
};

const startNavigation = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(
      `UPDATE routes SET status = 'in-progress', updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'planned' RETURNING *`,
      [id, req.user.id]
    );
    if (result.rows.length === 0) return notFound(res, 'Route not found or already started');
    return success(res, { route: result.rows[0] }, 'Navigation started');
  } catch (err) {
    console.error('Start navigation error:', err);
    return error(res, 'Failed to start navigation', 500);
  }
};

const completeRoute = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(
      `UPDATE routes SET status = 'completed', updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'in-progress' RETURNING *`,
      [id, req.user.id]
    );
    if (result.rows.length === 0) return notFound(res, 'Route not found or not in progress');
    return success(res, { route: result.rows[0] }, 'Route completed');
  } catch (err) {
    console.error('Complete route error:', err);
    return error(res, 'Failed to complete route', 500);
  }
};

module.exports = { createRoute, getRoutes, getRouteById, updateRoute, startNavigation, completeRoute };
