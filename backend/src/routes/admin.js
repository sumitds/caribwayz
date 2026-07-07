const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { authenticate, requireAdmin } = require('../middleware/auth');
const {
  getUsers, updateUserStatus, getAllReports, removeReport,
  addBusiness, getBusinesses, updateBusiness, getDashboardStats,
  getBroadcasts, createBroadcast, deleteBroadcast,
  getPartners, addPartner, updatePartnerStatus,
} = require('../controllers/adminController');

router.use(authenticate, requireAdmin);

router.get('/dashboard', getDashboardStats);

router.get('/users', getUsers);
router.patch('/users/:id/status', updateUserStatus);

router.get('/reports', getAllReports);
router.delete('/reports/:id', removeReport);

router.get('/businesses', getBusinesses);
router.post('/businesses', [
  body('name').notEmpty().withMessage('Business name is required'),
  body('latitude').isFloat().withMessage('Valid latitude required'),
  body('longitude').isFloat().withMessage('Valid longitude required'),
], validate, addBusiness);
router.patch('/businesses/:id', updateBusiness);

router.get('/broadcasts', getBroadcasts);
router.post('/broadcasts', [
  body('title').notEmpty().withMessage('Title is required'),
  body('message').notEmpty().withMessage('Message is required'),
  body('type').notEmpty().withMessage('Type is required'),
], validate, createBroadcast);
router.delete('/broadcasts/:id', deleteBroadcast);

router.get('/partners', getPartners);
router.post('/partners', [
  body('name').notEmpty().withMessage('Partner name is required'),
  body('tier').notEmpty().withMessage('Tier is required'),
  body('entity_type').notEmpty().withMessage('Entity type is required'),
], validate, addPartner);
router.patch('/partners/:id/status', updatePartnerStatus);

module.exports = router;
