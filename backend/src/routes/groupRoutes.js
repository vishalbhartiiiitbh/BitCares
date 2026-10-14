import { Router } from 'express';
import { addMember, balances, create, join, leave, list, remove, simplify, update } from '../controllers/groupController.js';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { requireAuth } from '../middlewares/authMiddleware.js';

const router = Router();
router.use(requireAuth);
router.get('/', asyncHandler(list));
router.post('/', asyncHandler(create));
router.post('/join', asyncHandler(join));
router.get('/:groupId/balances', asyncHandler(balances));
router.post('/:groupId/members', asyncHandler(addMember));
router.patch('/:groupId', asyncHandler(update));
router.delete('/:groupId', asyncHandler(remove));
router.post('/:groupId/leave', asyncHandler(leave));
router.get('/:groupId/simplify-debts', asyncHandler(simplify));
export default router;