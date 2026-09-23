import { Router } from 'express';
import { leave, simplify } from '../controllers/groupController.js';
import { asyncHandler } from '../middlewares/errorHandler.js';

const router = Router();
router.post('/:groupId/leave', asyncHandler(leave));
router.get('/:groupId/simplify-debts', asyncHandler(simplify));
export default router;