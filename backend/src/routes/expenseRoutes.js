import { Router } from 'express';
import { createExpense } from '../controllers/expenseController.js';
import { asyncHandler } from '../middlewares/errorHandler.js';

const router = Router();
router.post('/', asyncHandler(createExpense));
export default router;