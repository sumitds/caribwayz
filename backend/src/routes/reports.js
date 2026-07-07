const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { submitReport, getNearbyReports, confirmReport } = require('../controllers/reportController');

router.use(authenticate);

router.post(
  '/',
  [
    body('type').notEmpty().withMessage('Report type is required'),
    body('latitude').isFloat().withMessage('Valid latitude required'),
    body('longitude').isFloat().withMessage('Valid longitude required'),
  ],
  validate,
  submitReport
);

router.get('/nearby', getNearbyReports);
router.post('/:id/confirm', confirmReport);

module.exports = router;
