const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const {
  register, login, forgotPassword, verifyOtp, logout, googleLogin, facebookLogin, phoneLogin,
} = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { firebaseSignInLimiter, forgotPasswordLimiter, resetVerifyLimiter } = require('../middleware/rateLimits');
const { isPlaceholderName } = require('../utils/displayName');

/** Password rules for any field that sets a password: /register and a reset. */
const passwordRules = (field) =>
  body(field)
    .isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
    .matches(/[A-Z]/).withMessage('Password must contain at least 1 uppercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least 1 number')
    .matches(/[^A-Za-z0-9]/).withMessage('Password must contain at least 1 special symbol');

/**
 * Body of the Firebase sign-in routes. Everything except the token and an
 * optional name is ignored: email, name and photo come from the verified token.
 */
const firebaseSignInRules = [
  body('idToken')
    .isString().withMessage('idToken is required')
    .bail()
    .trim()
    .notEmpty().withMessage('idToken is required')
    // A Firebase ID token is around 1 KB; this only stops absurd payloads.
    .isLength({ max: 8192 }).withMessage('idToken is too long'),
  body('name')
    .optional({ values: 'null' })
    .isString().withMessage('Name must be text')
    .bail()
    .isLength({ max: 255 }).withMessage('Name must be at most 255 characters'),
];

router.post(
  '/register',
  [
    body('name')
      .trim()
      .notEmpty().withMessage('Name is required')
      .isLength({ max: 255 }).withMessage('Name must be at most 255 characters')
      .custom((name) => !isPlaceholderName(name)).withMessage('Please enter your full name'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('phone').trim().notEmpty().withMessage('Phone number is required'),
    body('emergency_contact').trim().notEmpty().withMessage('Emergency contact is required'),
    body('user_type')
      .isIn(['CaribDrivers', 'CaribOfficials'])
      .withMessage('user_type must be CaribDrivers or CaribOfficials'),
    passwordRules('password'),
  ],
  validate,
  register
);

router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  validate,
  login
);

router.post('/google-login', firebaseSignInLimiter, firebaseSignInRules, validate, googleLogin);
router.post('/facebook-login', firebaseSignInLimiter, firebaseSignInRules, validate, facebookLogin);
router.post('/phone-login', firebaseSignInLimiter, firebaseSignInRules, validate, phoneLogin);

router.post(
  '/forgot-password',
  forgotPasswordLimiter,
  [body('email').isEmail().withMessage('Valid email is required')],
  validate,
  forgotPassword
);

router.post(
  '/otp-verify',
  resetVerifyLimiter,
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('otp').isString().matches(/^[0-9]{6}$/).withMessage('OTP must be 6 digits'),
    passwordRules('new_password'),
  ],
  validate,
  verifyOtp
);

router.post('/logout', authenticate, logout);

module.exports = router;
