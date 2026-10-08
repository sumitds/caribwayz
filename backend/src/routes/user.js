const router = require('express').Router();
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { isPlaceholderName } = require('../utils/displayName');
const { getProfile, updateProfile, getPreferences, updatePreferences } = require('../controllers/userController');
const { exportData, deleteAccount } = require('../controllers/accountController');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'), false);
  },
});

router.use(authenticate);

router.get('/profile', getProfile);
// A name is optional here (omitted means unchanged), but a name that is sent
// must be a real one: "default" or whitespace would overwrite the stored name.
const profileValidators = [
  body('name')
    .optional()
    .isString().withMessage('Name must be text')
    .trim()
    .isLength({ max: 255 }).withMessage('Name must be at most 255 characters')
    .custom((name) => name === '' || !isPlaceholderName(name)).withMessage('Please enter your full name'),
];

router.put('/profile', upload.single('profile_image'), profileValidators, validate, updateProfile);
router.get('/preferences', getPreferences);
router.put('/preferences', updatePreferences);

// Per account, not per IP: the export runs a dozen queries and the delete
// checks a password, so neither may be hammered from one session.
const perUser = (max, windowMs, message) => rateLimit({
  windowMs,
  max,
  keyGenerator: (req) => `user:${req.user.id}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message },
});

router.get('/export', perUser(5, 60 * 60 * 1000, 'You can download your data 5 times an hour. Please try again later.'), exportData);
router.delete(
  '/account',
  perUser(5, 15 * 60 * 1000, 'Too many attempts to delete this account. Please try again in 15 minutes.'),
  deleteAccount
);

module.exports = router;
