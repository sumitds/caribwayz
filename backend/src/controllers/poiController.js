const { query } = require('../config/db');
const { haversineDistance } = require('../utils/haversine');
const { success, error } = require('../utils/response');

const getPois = async (req, res) => {
  try {
    const { lat, lng, radius = 10, category, limit = 50 } = req.query;

    let sql = `SELECT * FROM pois WHERE 1=1`;
    const params = [];

    if (category) {
      params.push(category);
      sql += ` AND category = $${params.length}`;
    }

    sql += ` LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const result = await query(sql, params);

    let pois = result.rows;

    if (lat && lng) {
      const userLat = parseFloat(lat);
      const userLng = parseFloat(lng);
      const radiusKm = parseFloat(radius);

      pois = pois
        .map(poi => ({
          ...poi,
          distance_km: parseFloat(haversineDistance(userLat, userLng, poi.latitude, poi.longitude).toFixed(2)),
        }))
        .filter(poi => poi.distance_km <= radiusKm)
        .sort((a, b) => a.distance_km - b.distance_km);
    }

    return success(res, { pois, count: pois.length });
  } catch (err) {
    console.error('Get POIs error:', err);
    return error(res, 'Failed to fetch POIs', 500);
  }
};

module.exports = { getPois };
