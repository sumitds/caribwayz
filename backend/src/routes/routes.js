const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const {
  createRoute, getRoutes, getRouteById, updateRoute, startNavigation, completeRoute,
} = require('../controllers/routeController');

router.use(authenticate);

router.post(
  '/create',
  [
    body('start_lat').isFloat().withMessage('Valid start latitude required'),
    body('start_lng').isFloat().withMessage('Valid start longitude required'),
    body('end_lat').isFloat().withMessage('Valid end latitude required'),
    body('end_lng').isFloat().withMessage('Valid end longitude required'),
  ],
  validate,
  createRoute
);

router.get('/', getRoutes);
router.get('/:id', getRouteById);
router.put('/:id', updateRoute);
router.post('/:id/start', startNavigation);
router.post('/:id/complete', completeRoute);

module.exports = router;
