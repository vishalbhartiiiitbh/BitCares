import { Router } from 'express';
import {
  listFriendRequests,
  listFriends,
  listSentFriendRequests,
  removeFriend,
  respondToFriendRequest,
  sendFriendRequest,
} from '../controllers/friendController.js';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { requireAuth } from '../middlewares/authMiddleware.js';

const router = Router();

router.use(requireAuth);
router.get('/', asyncHandler(listFriends));
router.get('/requests/sent', asyncHandler(listSentFriendRequests));
router.get('/requests', asyncHandler(listFriendRequests));
router.post('/requests', asyncHandler(sendFriendRequest));
router.post('/requests/:requestId/respond', asyncHandler(respondToFriendRequest));
router.delete('/:friendId', asyncHandler(removeFriend));

export default router;
