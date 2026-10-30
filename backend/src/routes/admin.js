const router = require('express').Router();
const { body, param, query } = require('express-validator');
const { validate } = require('../middleware/validate');
const { authenticate, requireAdmin } = require('../middleware/auth');
const {
  getUsers, updateUserStatus, updateResponderApproval, getAllReports, removeReport,
  getDashboardStats,
  getBroadcasts, createBroadcast, deleteBroadcast,
  getPartners, addPartner, updatePartnerStatus,
  getPayouts, updatePayoutStatus,
  BROADCAST_TYPES,
} = require('../controllers/adminController');
const members = require('../controllers/memberAdminController');
const { MEMBERSHIP_STATUSES, APPLICATION_STATUSES } = require('../services/membership');
const { isWebAddress } = require('../utils/webAddress');

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

// Member businesses (migration 025, docs/members-contract.md).

// express-validator checks each element of an array against isInt/isFloat,
// so { "latitude": [18] } would pass without this.
const isScalar = (value) => typeof value === 'number' || typeof value === 'string';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The largest value a Postgres INT column holds; a bigger id or order would
// fail in the database instead of answering a readable error.
const MAX_INT = 2147483647;

// A calendar date, with an optional time and offset. isISO8601 alone also
// passes "2026", "2026-10" and "2026-W05", which Postgres refuses.
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$/i;

/** Optional text; '' or null clears it. */
const text = (field, max, label) => body(field).optional({ values: 'null' })
  .isString().withMessage(`${label} must be text`).bail()
  .isLength({ max }).withMessage(`${label} must be at most ${max} characters`);

/** Optional email address; '' or null clears it. */
const email = (field, label) => body(field).optional({ values: 'null' })
  .custom((v) => v === '' || (typeof v === 'string' && v.length <= 255 && EMAIL_PATTERN.test(v)))
  .withMessage(`${label} must be an email address`);

/** Optional date and time; '' or null clears it. */
const dateTime = (field, label) => body(field).optional({ values: 'null' })
  .isString().withMessage(`${label} must be a date and time (ISO 8601)`).bail()
  .if(body(field).not().equals(''))
  .matches(CALENDAR_DATE).withMessage(`${label} must be a date and time (ISO 8601)`).bail()
  .isISO8601({ strict: true }).withMessage(`${label} must be a real date and time`);

const wholeNumber = (field, min, label, { nullable = true, max = MAX_INT } = {}) => body(field)
  .optional(nullable ? { values: 'null' } : undefined)
  .custom(isScalar).withMessage(`${label} must be a whole number`).bail()
  .isInt({ min, max })
  .withMessage(`${label} must be a whole number from ${min} to ${max}`);

const coordinate = (field, limit, label, { required }) => (required ? body(field) : body(field).optional())
  .custom(isScalar).withMessage(`Valid ${label} required`).bail()
  .isFloat({ min: -limit, max: limit }).withMessage(`Valid ${label} required (-${limit} to ${limit})`);

const bothOrNeither = body('longitude').custom((longitude, { req }) => {
  if ((req.body.latitude === undefined) !== (longitude === undefined)) {
    throw new Error('Give both latitude and longitude, or neither');
  }
  return true;
});

const businessRules = (required) => [
  (required ? body('name') : body('name').optional())
    .isString().withMessage('Business name is required').bail()
    .trim().isLength({ min: 1, max: 255 }).withMessage('Business name is required (at most 255 characters)'),
  coordinate('latitude', 90, 'latitude', { required }),
  coordinate('longitude', 180, 'longitude', { required }),
  text('category', 100, 'Category'),
  text('address', 1000, 'Address'),
  text('phone', 40, 'Phone'),
  text('website', 1000, 'Website').bail()
    .custom(isWebAddress).withMessage('Website must be a web address starting http:// or https://, such as www.example.com'),
  text('description', 5000, 'Description'),
  text('image_url', 2000, 'Image URL'),
  text('membership_tier', 50, 'Membership tier'),
  text('business_size', 20, 'Business size'),
  text('promo_text', 280, 'Promotion'),
  email('contact_email', 'Contact email'),
  body('is_active').optional().isBoolean({ strict: true }).withMessage('is_active must be true or false'),
  body('membership_status').optional().isIn(MEMBERSHIP_STATUSES)
    .withMessage(`membership_status must be one of: ${MEMBERSHIP_STATUSES.join(', ')}`),
  wholeNumber('tier_id', 1, 'tier_id'),
  wholeNumber('employee_count', 1, 'Employee count', { max: 1000000 }),
  dateTime('membership_expires_at', 'Membership expiry'),
  dateTime('promo_expires_at', 'Promotion expiry'),
];

router.get('/businesses', [
  query('membership_status').optional().isIn(MEMBERSHIP_STATUSES)
    .withMessage(`membership_status must be one of: ${MEMBERSHIP_STATUSES.join(', ')}`),
  query('is_active').optional().isIn(['true', 'false']).withMessage('is_active must be true or false'),
], validate, members.getBusinesses);
router.post('/businesses', businessRules(true), validate, members.addBusiness);
router.patch('/businesses/:id', [
  param('id').isUUID().withMessage('Unknown business'),
  ...businessRules(false),
  bothOrNeither,
], validate, members.updateBusiness);

const tierRules = (required) => [
  (required ? body('name') : body('name').optional())
    .isString().withMessage('Tier name is required').bail()
    .trim().isLength({ min: 1, max: 100 }).withMessage('Tier name is required (at most 100 characters)'),
  wholeNumber('min_employees', 1, 'Minimum employees', { nullable: false, max: 1000000 }),
  ...(required ? [body('min_employees').exists().withMessage('Minimum employees is required')] : []),
  wholeNumber('max_employees', 1, 'Maximum employees', { max: 1000000 }),
  body('annual_fee').optional({ values: 'null' })
    .custom(isScalar).withMessage('Annual fee must be an amount').bail()
    .isFloat({ min: 0, max: 99999999.99 }).withMessage('Annual fee must be an amount from 0'),
  body('currency').optional().isString().withMessage('Currency must be text').bail()
    .matches(/^[A-Z]{3}$/).withMessage('Currency must be a three-letter code such as USD'),
  body('is_provisional').optional().isBoolean({ strict: true }).withMessage('is_provisional must be true or false'),
  body('is_active').optional().isBoolean({ strict: true }).withMessage('is_active must be true or false'),
  wholeNumber('sort_order', 0, 'Sort order'),
];

router.get('/membership-tiers', members.getTiers);
router.post('/membership-tiers', tierRules(true), validate, members.addTier);
router.patch('/membership-tiers/:id', [
  param('id').isInt({ min: 1, max: MAX_INT }).withMessage('Unknown tier'),
  ...tierRules(false),
], validate, members.updateTier);

router.get('/membership-applications', [
  query('status').optional().isIn(APPLICATION_STATUSES)
    .withMessage(`status must be one of: ${APPLICATION_STATUSES.join(', ')}`),
], validate, members.getApplications);
router.patch('/membership-applications/:id', [
  param('id').isUUID().withMessage('Unknown application'),
  body('status').optional().isIn(APPLICATION_STATUSES)
    .withMessage(`status must be one of: ${APPLICATION_STATUSES.join(', ')}`),
  text('admin_notes', 5000, 'Notes'),
], validate, members.updateApplication);
router.post('/membership-applications/:id/activate', [
  param('id').isUUID().withMessage('Unknown application'),
  coordinate('latitude', 90, 'latitude', { required: false }),
  coordinate('longitude', 180, 'longitude', { required: false }),
  bothOrNeither,
  wholeNumber('months', 1, 'Months', { max: 120 }),
], validate, members.activateApplication);

router.get('/membership-settings', members.getSettings);
router.put('/membership-settings', [
  body('payment_instructions').optional({ values: 'null' })
    .isString().withMessage('Payment instructions must be text').bail()
    .isLength({ max: 5000 }).withMessage('Payment instructions must be at most 5000 characters'),
  email('contact_email', 'Contact email'),
], validate, members.updateSettings);

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

router.get('/payouts', getPayouts);
router.patch('/payouts/:id', updatePayoutStatus);

module.exports = router;
