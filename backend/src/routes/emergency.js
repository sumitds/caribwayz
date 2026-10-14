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
  EMERGENCY_TYPES,
} = require('../controllers/emergencyController');

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

router.get('/:id', getEmergencyStatus);
router.post('/:id/resolve', resolveEmergency);

// The emergency desk: an operator takes an alert so no two answer the same
// SOS, and can hand it back. Responders and admins only.
router.post('/:id/acknowledge', requireResponder, acknowledgeEmergency);
router.post('/:id/release', requireResponder, releaseEmergency);

module.exports = router;
