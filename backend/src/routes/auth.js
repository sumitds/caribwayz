const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { register, login, forgotPassword, verifyOtp, logout } = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { isPlaceholderName } = require('../utils/displayName');

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
    body('password')
      .isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
      .matches(/[A-Z]/).withMessage('Password must contain at least 1 uppercase letter')
      .matches(/[0-9]/).withMessage('Password must contain at least 1 number')
      .matches(/[^A-Za-z0-9]/).withMessage('Password must contain at least 1 special symbol'),
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

router.post(
  '/forgot-password',
  [body('email').isEmail().withMessage('Valid email is required')],
  validate,
  forgotPassword
);

router.post(
  '/otp-verify',
  [
    body('email').isEmail(),
    body('otp').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits'),
    body('new_password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],
  validate,
  verifyOtp
);

router.post('/logout', authenticate, logout);

module.exports = router;
