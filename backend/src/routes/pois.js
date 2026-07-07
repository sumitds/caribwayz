const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getPois } = require('../controllers/poiController');

router.use(authenticate);
router.get('/', getPois);

module.exports = router;
