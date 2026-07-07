const router = require('express').Router();
const { authenticate, requireAdmin } = require('../middleware/auth');
const { getMyRecords, getRecordById, createRecord, deleteRecord, getAllRecords } = require('../controllers/recordController');

router.use(authenticate);

router.get('/', getMyRecords);
router.get('/:id', getRecordById);
router.post('/', createRecord);
router.delete('/:id', deleteRecord);

router.get('/admin/all', requireAdmin, getAllRecords);

module.exports = router;
