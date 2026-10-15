const router = require('express').Router();
const multer = require('multer');
const { body } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { perUser } = require('../middleware/rateLimit');
const { isPlaceholderName } = require('../utils/displayName');
const {
  getProfile, updateProfile, getPreferences, updatePreferences,
  registerDeviceToken, removeDeviceToken, updateAlertArea,
} = require('../controllers/userController');
const { exportData, deleteAccount } = require('../controllers/accountController');
const security = require('../controllers/securityController');
const { getEmergencyContacts, replaceEmergencyContacts } = require('../controllers/emergencyContactsController');
const { listBlocked, blockUser, unblockUser } = require('../controllers/blockController');
const { normalizeContactPhone } = require('../utils/phone');

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
  // The same rule as sign-up and every trusted contact: 7 to 15 digits with an
  // optional leading +. It becomes the first number texted in an SOS.
  body('emergency_contact')
    .optional({ values: 'falsy' })
    .custom((value) => normalizeContactPhone(value) !== null)
    .withMessage('Enter a valid phone number (7-15 digits)'),
];

router.put('/profile', upload.single('profile_image'), profileValidators, validate, updateProfile);
router.get('/preferences', getPreferences);
// The push switches are optional, but one that is sent must be a real boolean:
// the string "false" would otherwise be stored as true.
const PUSH_PREFERENCES = ['push_emergency', 'push_group', 'push_reports', 'push_app_updates', 'push_promotions', 'push_weather'];
const preferenceValidators = PUSH_PREFERENCES.map((field) =>
  body(field).optional().custom((value) => typeof value === 'boolean').withMessage(`${field} must be true or false`)
);
router.put('/preferences', preferenceValidators, validate, updatePreferences);

// Trusted contacts texted on an SOS. Validation lives in the controller, which
// answers 400 with a sentence the app shows as it is.
const contactsLimit = perUser(60, 60 * 60 * 1000, 'Too many changes to your trusted contacts. Please try again later.');
router.get('/emergency-contacts', getEmergencyContacts);
router.put('/emergency-contacts', contactsLimit, replaceEmergencyContacts);

// People the caller has blocked. See services/blockService.js for what a block does.
const blockLimit = perUser(60, 60 * 60 * 1000, 'Too many block or unblock requests. Please try again later.');
router.get('/blocks', listBlocked);
router.post('/blocks', blockLimit, blockUser);
router.delete('/blocks/:user_id', blockLimit, unblockUser);

// An FCM registration token is about 160 characters; the cap only stops abuse
// of the column and is far above any real token.
const DEVICE_TOKEN_MAX_LENGTH = 4096;
const deviceTokenValidator = () => body('token')
  .isString().withMessage('token is required')
  .bail()
  .trim()
  .isLength({ min: 1, max: DEVICE_TOKEN_MAX_LENGTH }).withMessage(`token must be 1 to ${DEVICE_TOKEN_MAX_LENGTH} characters`);

const deviceTokenLimit = perUser(60, 60 * 60 * 1000, 'Too many device registrations. Please try again later.');
router.post(
  '/device-token',
  deviceTokenLimit,
  [
    deviceTokenValidator(),
    body('platform').isIn(['android', 'ios']).withMessage('platform must be android or ios'),
  ],
  validate,
  registerDeviceToken
);
router.delete('/device-token', deviceTokenLimit, [deviceTokenValidator()], validate, removeDeviceToken);

// The rough area for weather alerts. Coordinates must be real numbers in
// range; strings are refused rather than parsed.
const coordinate = (field, limit) => body(field)
  .custom((value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit)
  .withMessage(`${field} must be a number from -${limit} to ${limit}`);
router.put(
  '/alert-area',
  perUser(30, 60 * 60 * 1000, 'Too many updates. Please try again later.'),
  [coordinate('latitude', 90), coordinate('longitude', 180)],
  validate,
  updateAlertArea
);

// Per account, not per IP: the export runs a dozen queries and the delete
// checks a password, so neither may be hammered from one session.
router.get('/export', perUser(5, 60 * 60 * 1000, 'You can download your data 5 times an hour. Please try again later.'), exportData);
router.delete(
  '/account',
  perUser(5, 15 * 60 * 1000, 'Too many attempts to delete this account. Please try again in 15 minutes.'),
  deleteAccount
);

// Sign-in history and two-step sign-in. Per account: setup and switch-off
// check a password, and each setup sends an email.
const securityLimit = perUser(20, 15 * 60 * 1000, 'Too many attempts. Please wait 15 minutes and try again.');
router.get('/sessions', security.listSessions);
router.post('/sessions/sign-out-others', securityLimit, security.signOutOtherSessions);
router.get('/two-factor', security.getTwoFactor);
router.post('/two-factor/setup', securityLimit, security.startTwoFactorSetup);
router.post(
  '/two-factor/enable',
  securityLimit,
  [body('code').isString().matches(/^[0-9]{6}$/).withMessage('Code must be 6 digits')],
  validate,
  security.confirmTwoFactorSetup
);
router.post('/two-factor/disable', securityLimit, security.disableTwoFactor);

module.exports = router;
