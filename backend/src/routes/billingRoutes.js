import { Router } from 'express';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { requireAuth } from '../middlewares/authMiddleware.js';
import { createPremiumOrder, razorpayWebhook, verifyPremiumPayment } from '../controllers/billingController.js';

const router = Router();
router.post('/webhook', asyncHandler(razorpayWebhook));
router.post('/premium/order', requireAuth, asyncHandler(createPremiumOrder));
router.post('/premium/verify', requireAuth, asyncHandler(verifyPremiumPayment));

export default router;