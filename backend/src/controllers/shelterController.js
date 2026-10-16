const db = require('../config/db');
const shelters = require('../services/emergencyShelters');
const { territoryFor } = require('../services/roadsidePlaces');
const { success, error } = require('../utils/response');

const DEFAULT_RADIUS_METERS = 30000;
const MIN_RADIUS_METERS = 50;
const MAX_RADIUS_METERS = 50000;
const DEFAULT_LIMIT = 40;

/**
 * Builds the handler with its dependencies passed in, so tests can supply a
 * fake query and dataset. The module exports one wired to the real database.
 */
const buildShelterHandlers = ({ query, loadDataset, findNearby, isDatasetLoaded }) => {
  /**
   * GET /shelters?lat=..&lng=..&radius=30000&limit=40
   *
   * covered tells the app whether this answer is authoritative. Inside a
   * territory CaribWayz has data for, an empty list really means nothing is
   * mapped nearby. Outside them, and inside them until the table holds this
   * dataset version (seeding runs after the server starts), covered is false
   * and the app asks Overpass itself.
   * The data says where shelters are designated, never whether one is open.
   */
  const getShelters = async (req, res) => {
    try {
      const latitude = Number(req.query.lat);
      const longitude = Number(req.query.lng);
      if (req.query.lat === undefined || req.query.lng === undefined ||
          !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
          !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
        return error(res, 'lat and lng must be a valid coordinate', 400);
      }

      let radiusMeters = DEFAULT_RADIUS_METERS;
      if (req.query.radius !== undefined) {
        radiusMeters = Number(req.query.radius);
        if (!Number.isFinite(radiusMeters)) return error(res, 'radius must be a number of metres', 400);
        radiusMeters = Math.min(Math.max(radiusMeters, MIN_RADIUS_METERS), MAX_RADIUS_METERS);
      }

      let limit = DEFAULT_LIMIT;
      if (req.query.limit !== undefined) {
        limit = Number(req.query.limit);
        if (!Number.isInteger(limit) || limit < 1) return error(res, 'limit must be a whole number from 1', 400);
        limit = Math.min(limit, shelters.MAX_RESULTS);
      }

      const dataset = loadDataset();
      const territory = territoryFor(latitude, longitude, dataset.territories);
      if (!territory) {
        return success(res, { covered: false, territory: null, elements: [] });
      }

      if (!(await isDatasetLoaded(query, dataset))) {
        return success(res, { covered: false, territory, elements: [] });
      }

      const elements = await findNearby(query, { latitude, longitude, radiusMeters, limit });
      return success(res, {
        covered: true,
        territory,
        dataset: dataset.version,
        elements,
      });
    } catch (err) {
      console.error('Shelters lookup error:', err);
      return error(res, 'Failed to look up shelters', 500);
    }
  };

  return { getShelters };
};

const { getShelters } = buildShelterHandlers({
  query: db.query,
  loadDataset: () => shelters.loadDataset(),
  findNearby: shelters.findNearby,
  isDatasetLoaded: shelters.isDatasetLoaded,
});

module.exports = { buildShelterHandlers, getShelters };
