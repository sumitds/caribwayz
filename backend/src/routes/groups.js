const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { perUser } = require('../middleware/rateLimit');
const { createGroup, joinGroup, getGroupDetails, leaveGroup, updateLocation, inviteToGroup, getGroupsByUser } = require('../controllers/groupController');
// Validation for these lives in the controller: the mobile client expects 400
// with a readable message, while the shared `validate` middleware answers 422.
const { sendSos, checkIn, deleteGroup, reportStatus } = require('../controllers/groupEventController');
const { listInvites, acceptInvite, declineInvite } = require('../controllers/groupInviteController');

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
// Invites inside the app (migration 028). Above '/:id', which would otherwise
// take "invites" for a group id.
router.get('/invites', listInvites);
router.post('/invites/:inviteId/accept', acceptInvite);
router.post('/invites/:inviteId/decline', declineInvite);
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
// A member's app reports their own status (arrived, stopped, running late,
// left the drive). The controller already shares each status at most once per
// window; this caps the requests themselves, for an app stuck in a loop.
const GROUP_STATUS_LIMIT = 30;
router.post(
  '/:id/status',
  perUser(GROUP_STATUS_LIMIT, GROUP_EVENT_WINDOW_MS, 'Too many status updates to this group. Please wait a few minutes.', (req) => `group-status:${req.params.id}`),
  reportStatus
);
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
