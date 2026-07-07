const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getNotifications, markAsRead } = require('../controllers/notificationController');

router.use(authenticate);
router.get('/', getNotifications);
router.post('/read', markAsRead);

module.exports = router;
