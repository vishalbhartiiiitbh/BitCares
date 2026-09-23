import { Router } from 'express';
import { createExpense, list } from '../controllers/expenseController.js';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { requireAuth } from '../middlewares/authMiddleware.js';

const router = Router();
router.use(requireAuth);
router.get('/', asyncHandler(list));
router.post('/', asyncHandler(createExpense));
export default router;