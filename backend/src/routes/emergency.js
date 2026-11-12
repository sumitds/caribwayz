const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { authenticate, requireResponder } = require('../middleware/auth');
const { perUser } = require('../middleware/rateLimit');
const {
  triggerEmergency,
  listEmergencies,
  getEmergencyStatus,
  resolveEmergency,
  acknowledgeEmergency,
  releaseEmergency,
  updateAlertLocation,
  EMERGENCY_TYPES,
} = require('../controllers/emergencyController');
const { getContactAlert, listContactAlerts } = require('../controllers/emergencyContactAlertController');

router.use(authenticate);

// Every alert rings every responder's phone on the loud alert channel, so one
// account may not raise more than a few in a short time. The limit is far above
// what a real emergency needs: the first alert is already with the desk.
const EMERGENCY_LIMIT = 5;
const EMERGENCY_WINDOW_MS = 10 * 60 * 1000;

router.post(
  '/',
  perUser(
    EMERGENCY_LIMIT,
    EMERGENCY_WINDOW_MS,
    'You have raised several emergency alerts in the last few minutes. Responders already have them; please wait before sending another.'
  ),
  [
    body('type')
      .notEmpty().withMessage('Emergency type is required')
      .bail()
      .isIn(EMERGENCY_TYPES)
      .withMessage(`Emergency type must be one of: ${EMERGENCY_TYPES.join(', ')}`),
    body('latitude')
      .isFloat({ min: -90, max: 90 })
      .withMessage('Valid latitude required'),
    body('longitude')
      .isFloat({ min: -180, max: 180 })
      .withMessage('Valid longitude required'),
  ],
  validate,
  triggerEmergency
);

// The responder feed. Declared before '/:id' so the literal path is not
// swallowed by the parameterised one, and gated to responders and admins
// because these rows are the live locations of people in trouble.
router.get('/', requireResponder, listEmergencies);

// Alerts raised by people who have the caller as a trusted contact. Declared
// before '/:id' for the same reason as the feed.
router.get('/contact-alerts', listContactAlerts);
router.get('/contact-alerts/:id', getContactAlert);

router.get('/:id', getEmergencyStatus);
router.post('/:id/resolve', resolveEmergency);

// The sender's phone sends where they are every 15 to 30 seconds while the
// alert is open. Twelve a minute leaves room for a retry after a dropped
// connection; more than that is not a phone keeping a map current.
const LOCATION_UPDATE_LIMIT = 12;
const LOCATION_UPDATE_WINDOW_MS = 60 * 1000;

router.patch(
  '/:id/location',
  perUser(
    LOCATION_UPDATE_LIMIT,
    LOCATION_UPDATE_WINDOW_MS,
    'Your location is being sent too often. It will be sent again shortly.'
  ),
  [
    body('latitude')
      .isFloat({ min: -90, max: 90 })
      .withMessage('Valid latitude required'),
    body('longitude')
      .isFloat({ min: -180, max: 180 })
      .withMessage('Valid longitude required'),
  ],
  validate,
  updateAlertLocation
);

// The emergency desk: an operator takes an alert so no two answer the same
// SOS, and can hand it back. Responders and admins only.
router.post('/:id/acknowledge', requireResponder, acknowledgeEmergency);
router.post('/:id/release', requireResponder, releaseEmergency);

module.exports = router;
