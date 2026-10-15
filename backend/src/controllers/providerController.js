const db = require('../config/db');
const roadside = require('../services/roadsidePlaces');
const { success, error } = require('../utils/response');

const DEFAULT_RADIUS_METERS = 5000;
const MIN_RADIUS_METERS = 50;
const MAX_RADIUS_METERS = 50000;

/**
 * Builds the handler with its dependencies passed in, so tests can supply a
 * fake query and dataset. The module exports one wired to the real database.
 */
const buildProviderHandlers = ({ query, loadDataset, findNearby, isDatasetLoaded }) => {
  /**
   * GET /providers?key=roadside_towing&lat=..&lng=..&radius=5000
   *
   * covered tells the app whether this answer is authoritative. Inside a
   * territory CaribWayz has data for, an empty list really means nothing is
   * mapped nearby. Outside them, and inside them until the table holds this
   * dataset version (seeding runs after the server starts), covered is false
   * and the app asks Overpass itself.
   */
  const getProviders = async (req, res) => {
    try {
      const { key } = req.query;
      if (!Object.prototype.hasOwnProperty.call(roadside.LOOKUP_KINDS, key)) {
        return error(res, `key must be one of: ${Object.keys(roadside.LOOKUP_KINDS).join(', ')}`, 400);
      }

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

      const dataset = loadDataset();
      const territory = roadside.territoryFor(latitude, longitude, dataset.territories);
      if (!territory) {
        return success(res, { covered: false, territory: null, elements: [] });
      }

      if (!(await isDatasetLoaded(query, dataset))) {
        return success(res, { covered: false, territory, elements: [] });
      }

      const elements = await findNearby(query, { key, latitude, longitude, radiusMeters });
      return success(res, {
        covered: true,
        territory,
        dataset: dataset.version,
        elements,
      });
    } catch (err) {
      console.error(`Providers lookup error (key ${req.query && req.query.key}):`, err);
      return error(res, 'Failed to look up providers', 500);
    }
  };

  return { getProviders };
};

const { getProviders } = buildProviderHandlers({
  query: db.query,
  loadDataset: () => roadside.loadDataset(),
  findNearby: roadside.findNearby,
  isDatasetLoaded: roadside.isDatasetLoaded,
});

module.exports = { buildProviderHandlers, getProviders };
