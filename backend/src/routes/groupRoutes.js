import { Router } from 'express';
import { create, join, leave, list, simplify } from '../controllers/groupController.js';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { requireAuth } from '../middlewares/authMiddleware.js';

const router = Router();
router.use(requireAuth);
router.get('/', asyncHandler(list));
router.post('/', asyncHandler(create));
router.post('/join', asyncHandler(join));
router.post('/:groupId/leave', asyncHandler(leave));
router.get('/:groupId/simplify-debts', asyncHandler(simplify));
export default router;