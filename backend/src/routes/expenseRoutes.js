import { Router } from 'express';
import { createComment, createExpense, currencies, editExpense, list, listPersonal, removeComment, removeExpense } from '../controllers/expenseController.js';
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
router.get('/currencies', asyncHandler(currencies));
router.get('/personal', asyncHandler(listPersonal));
router.get('/', asyncHandler(list));
router.post('/', upload.single('paymentProof'), asyncHandler(createExpense));
router.patch('/:expenseId', upload.single('paymentProof'), asyncHandler(editExpense));
router.delete('/:expenseId', asyncHandler(removeExpense));
router.post('/:expenseId/comments', asyncHandler(createComment));
router.delete('/comments/:commentId', asyncHandler(removeComment));
export default router;