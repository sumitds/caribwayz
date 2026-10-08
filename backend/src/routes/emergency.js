const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { authenticate, requireResponder } = require('../middleware/auth');
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

router.post(
  '/',
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
