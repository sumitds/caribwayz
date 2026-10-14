const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { authenticate, requireAdmin } = require('../middleware/auth');
const {
  getUsers, updateUserStatus, updateResponderApproval, getAllReports, removeReport,
  addBusiness, getBusinesses, updateBusiness, getDashboardStats,
  getBroadcasts, createBroadcast, deleteBroadcast,
  getPartners, addPartner, updatePartnerStatus,
  getSponsorships, updateSponsorshipStatus,
  getPayouts, updatePayoutStatus,
  BROADCAST_TYPES,
} = require('../controllers/adminController');

router.use(authenticate, requireAdmin);

router.get('/dashboard', getDashboardStats);

router.get('/users', getUsers);
router.patch('/users/:id/status', updateUserStatus);

// The only route that can grant emergency-responder access. Gated by
// requireAdmin at the top of this router.
router.patch('/users/:id/responder', [
  body('approved').isBoolean().withMessage('approved must be true or false'),
], validate, updateResponderApproval);

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
  body('type').isIn(BROADCAST_TYPES).withMessage(`Type must be one of: ${BROADCAST_TYPES.join(', ')}`),
], validate, createBroadcast);
router.delete('/broadcasts/:id', deleteBroadcast);

router.get('/partners', getPartners);
router.post('/partners', [
  body('name').notEmpty().withMessage('Partner name is required'),
  body('tier').notEmpty().withMessage('Tier is required'),
  body('entity_type').notEmpty().withMessage('Entity type is required'),
], validate, addPartner);
router.patch('/partners/:id/status', updatePartnerStatus);

router.get('/sponsorships', getSponsorships);
router.patch('/sponsorships/:id', updateSponsorshipStatus);

router.get('/payouts', getPayouts);
router.patch('/payouts/:id', updatePayoutStatus);

module.exports = router;
