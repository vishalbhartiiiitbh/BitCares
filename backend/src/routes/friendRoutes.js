import { Router } from 'express';
import {
  listFriendRequests,
  listFriends,
  listSentFriendRequests,
  removeFriend,
  respondToFriendRequest,
  sendFriendRequest,
  createFriendExpense,
  deleteFriendExpense,
  friendActivity,
  friendHistory,
  settleFriend,
  updateFriendExpense,
} from '../controllers/friendController.js';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { requireAuth } from '../middlewares/authMiddleware.js';
import multer from 'multer';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!file.mimetype.startsWith('image/')) {
      callback(Object.assign(new Error('Payment proof must be an image'), { statusCode: 400 }));
      return;
    }
    callback(null, true);
  },
});
router.use(requireAuth);
router.get('/', asyncHandler(listFriends));
router.get('/activity', asyncHandler(friendActivity));
router.get('/requests/sent', asyncHandler(listSentFriendRequests));
router.get('/requests', asyncHandler(listFriendRequests));
router.post('/requests', asyncHandler(sendFriendRequest));
router.post('/requests/:requestId/respond', asyncHandler(respondToFriendRequest));
router.get('/:friendId/history', asyncHandler(friendHistory));
router.post('/:friendId/expenses', upload.single('paymentProof'), asyncHandler(createFriendExpense));
router.patch('/:friendId/expenses/:expenseId', upload.single('paymentProof'), asyncHandler(updateFriendExpense));
router.delete('/:friendId/expenses/:expenseId', asyncHandler(deleteFriendExpense));
router.post('/:friendId/settlements', asyncHandler(settleFriend));
router.delete('/:friendId', asyncHandler(removeFriend));

export default router;
