const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getProviders } = require('../controllers/providerController');

router.use(authenticate);
router.get('/', getProviders);

module.exports = router;
