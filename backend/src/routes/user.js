const router = require('express').Router();
const multer = require('multer');
const { authenticate } = require('../middleware/auth');
const { getProfile, updateProfile, getPreferences, updatePreferences } = require('../controllers/userController');

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
router.put('/profile', upload.single('profile_image'), updateProfile);
router.get('/preferences', getPreferences);
router.put('/preferences', updatePreferences);

module.exports = router;
