const router = require('express').Router();
const { body, query } = require('express-validator');
const { validateWithStatus } = require('../middleware/validate');
const { membershipApplyLimiter } = require('../middleware/rateLimits');
const { getNearby, getTiers, apply, dropBotApplication } = require('../controllers/membershipController');
const { isWebAddress } = require('../utils/webAddress');

// Public: the app shows member businesses before sign-in too, and the
// /membership web page has no login. Bad input answers 400
// (docs/members-contract.md).
const validate = validateWithStatus(400);

const PHONE_PATTERN = /^[0-9+().\-\s]{5,40}$/;

// express-validator checks each element of an array against isInt/isFloat,
// so ?lat=1&lat=2 or { "employee_count": [5] } would pass without this.
const isScalar = (value) => typeof value === 'number' || typeof value === 'string';

router.get('/nearby', [
  query('lat').exists({ values: 'falsy' }).withMessage('lat is required').bail()
    .custom(isScalar).withMessage('lat must be one number').bail()
    .isFloat({ min: -90, max: 90 }).withMessage('lat must be a latitude from -90 to 90'),
  query('lng').exists({ values: 'falsy' }).withMessage('lng is required').bail()
    .custom(isScalar).withMessage('lng must be one number').bail()
    .isFloat({ min: -180, max: 180 }).withMessage('lng must be a longitude from -180 to 180'),
  query('radius_m').optional().custom(isScalar).withMessage('radius_m must be one number').bail().isInt().withMessage('radius_m must be a whole number of metres'),
], validate, getNearby);

router.get('/tiers', getTiers);

const optionalString = (field, max, label) => body(field)
  .optional({ values: 'null' })
  .isString().withMessage(`${label} must be text`).bail()
  .trim()
  .isLength({ max }).withMessage(`${label} must be at most ${max} characters`);

const coordinate = (field, limit, label) => body(field)
  .optional({ values: 'null' })
  .custom(isScalar).withMessage(`${label} must be a number`).bail()
  .isFloat({ min: -limit, max: limit }).withMessage(`${label} must be from -${limit} to ${limit}`);

// The limiter counts before validation: a flood of bad forms is still a flood.
// A form with the hidden field filled is answered and dropped before that.
router.post('/apply', membershipApplyLimiter, dropBotApplication, [
  body('business_name').isString().withMessage('Business name is required').bail()
    .trim().isLength({ min: 2, max: 200 }).withMessage('Business name must be 2 to 200 characters'),
  body('contact_name').isString().withMessage('Contact name is required').bail()
    .trim().isLength({ min: 1, max: 200 }).withMessage('Contact name is required (at most 200 characters)'),
  body('email').isString().withMessage('A valid email address is required').bail()
    .trim().isLength({ max: 255 }).withMessage('Email must be at most 255 characters').bail()
    .isEmail().withMessage('A valid email address is required'),
  optionalString('phone', 40, 'Phone')
    .custom((value) => value === '' || PHONE_PATTERN.test(value)).withMessage('Phone must be a phone number'),
  optionalString('address', 500, 'Address'),
  optionalString('category', 100, 'Category'),
  body('employee_count').custom(isScalar).withMessage('Number of employees is required').bail()
    .isInt({ min: 1, max: 1000000 })
    .withMessage('Number of employees must be a whole number from 1 to 1000000'),
  optionalString('website', 500, 'Website')
    .custom(isWebAddress).withMessage('Website must be a web address starting http:// or https://, such as www.example.com'),
  optionalString('message', 2000, 'Message'),
  coordinate('latitude', 90, 'Latitude'),
  coordinate('longitude', 180, 'Longitude'),
  body('longitude').custom((longitude, { req }) => {
    const given = (v) => v !== undefined && v !== null;
    if (given(req.body.latitude) !== given(longitude)) {
      throw new Error('Give both latitude and longitude, or neither');
    }
    return true;
  }),
], validate, apply);

module.exports = router;
