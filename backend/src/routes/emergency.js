const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { triggerEmergency, getEmergencyStatus, resolveEmergency } = require('../controllers/emergencyController');

router.use(authenticate);

router.post(
  '/',
  [
    body('type').notEmpty().withMessage('Emergency type is required'),
    body('latitude').isFloat().withMessage('Valid latitude required'),
    body('longitude').isFloat().withMessage('Valid longitude required'),
  ],
  validate,
  triggerEmergency
);

router.get('/:id', getEmergencyStatus);
router.post('/:id/resolve', resolveEmergency);

module.exports = router;
