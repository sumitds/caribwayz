const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { perUser } = require('../middleware/rateLimit');
const { createGroup, joinGroup, getGroupDetails, leaveGroup, updateLocation, inviteToGroup, getGroupsByUser } = require('../controllers/groupController');
// Validation for these lives in the controller: the mobile client expects 400
// with a readable message, while the shared `validate` middleware answers 422.
const { sendSos, checkIn, deleteGroup } = require('../controllers/groupEventController');

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
router.delete('/:id', deleteGroup);
router.post('/:id/leave', leaveGroup);
router.post('/:id/location', updateLocation);
// An SOS or check-in pushes to every member's phone, so each member gets a
// budget per group: generous for real use, but no loop of alerts.
const GROUP_EVENT_LIMIT = 10;
const GROUP_EVENT_WINDOW_MS = 10 * 60 * 1000;
const perGroupMember = (message) => perUser(GROUP_EVENT_LIMIT, GROUP_EVENT_WINDOW_MS, message, (req) => `group:${req.params.id}`);
router.post('/:id/sos', perGroupMember('Too many SOS alerts to this group. Please wait a few minutes before sending another.'), sendSos);
router.post('/:id/check-in', perGroupMember('Too many check-ins to this group. Please wait a few minutes before checking in again.'), checkIn);
// Each address on an invite is an email to someone else's inbox, so one
// invite names at most MAX_INVITE_ADDRESSES and each account has a budget.
const MAX_INVITE_ADDRESSES = 10;
const INVITE_LIMIT = 20;
const INVITE_WINDOW_MS = 60 * 60 * 1000;
router.post(
  '/:id/invite',
  perUser(INVITE_LIMIT, INVITE_WINDOW_MS, 'You have sent a lot of invitations. Please wait an hour and try again.'),
  [
    body('email')
      .isArray({ min: 1 }).withMessage('email must be a non-empty array')
      .bail()
      .isArray({ max: MAX_INVITE_ADDRESSES }).withMessage(`You can invite up to ${MAX_INVITE_ADDRESSES} people at a time`),
    body('email.*').isEmail().withMessage('Each email must be a valid address'),
  ],
  validate,
  inviteToGroup
);

module.exports = router;
