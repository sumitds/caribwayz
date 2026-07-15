const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { createGroup, joinGroup, getGroupDetails, leaveGroup, updateLocation, inviteToGroup, getGroupsByUser } = require('../controllers/groupController');

router.use(authenticate);

router.post(
  '/',
  [body('group_name').notEmpty().withMessage('Group name is required')],
  validate,
  createGroup
);

router.post(
  '/join',
  [body('join_code').notEmpty().withMessage('Join code is required')],
  validate,
  joinGroup
);

router.get('/user/:user_id', getGroupsByUser);
router.get('/:id', getGroupDetails);
router.post('/:id/leave', leaveGroup);
router.post('/:id/location', updateLocation);
router.post(
  '/:id/invite',
  [
    body('email').isArray({ min: 1 }).withMessage('email must be a non-empty array'),
    body('email.*').isEmail().withMessage('Each email must be a valid address'),
  ],
  validate,
  inviteToGroup
);

module.exports = router;
