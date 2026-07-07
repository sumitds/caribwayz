/**
 * Haversine formula — calculates the great-circle distance between two
 * geographic coordinates (in kilometres).
 */
const haversineDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const toRad = (deg) => deg * (Math.PI / 180);

/**
 * Estimates ETA in minutes based on distance (km) and average speed (km/h).
 */
const estimateETA = (distanceKm, avgSpeedKmh = 50) => {
  return Math.round((distanceKm / avgSpeedKmh) * 60);
};

module.exports = { haversineDistance, estimateETA };
