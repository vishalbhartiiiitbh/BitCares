import { Router } from 'express';
import multer from 'multer';
import { addMember, balances, create, join, leave, list, remove, removeMember, settle, simplify, update } from '../controllers/groupController.js';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { requireAuth } from '../middlewares/authMiddleware.js';

const router = Router();
const uploadProof = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!file.mimetype.startsWith('image/')) {
      callback(Object.assign(new Error('Uploaded file must be an image'), { statusCode: 400 }));
      return;
    }
    callback(null, true);
  },
});
router.use(requireAuth);
router.get('/', asyncHandler(list));
router.post('/', asyncHandler(create));
router.post('/join', asyncHandler(join));
router.get('/:groupId/balances', asyncHandler(balances));
router.post('/:groupId/members', asyncHandler(addMember));
router.delete('/:groupId/members/:memberId', asyncHandler(removeMember));
router.post('/:groupId/settlements', uploadProof.single('paymentProof'), asyncHandler(settle));
router.patch('/:groupId', uploadProof.single('coverImage'), asyncHandler(update));
router.delete('/:groupId', asyncHandler(remove));
router.post('/:groupId/leave', asyncHandler(leave));
router.get('/:groupId/simplify-debts', asyncHandler(simplify));
export default router;