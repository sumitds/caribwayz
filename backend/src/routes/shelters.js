const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getShelters } = require('../controllers/shelterController');

router.use(authenticate);
router.get('/', getShelters);

module.exports = router;
