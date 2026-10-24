import { Router } from 'express';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { requireAuth } from '../middlewares/authMiddleware.js';
import {
  cancelPremiumSubscription,
  changePremiumSubscription,
  createPremiumOrder,
  createPremiumSubscription,
  getBillingSummary,
  listSubscriptionPlans,
  razorpayWebhook,
  validatePremiumCoupon,
  verifyPremiumPayment,
  verifyPremiumSubscription,
} from '../controllers/billingController.js';

const router = Router();
router.post('/webhook', asyncHandler(razorpayWebhook));
router.get('/plans', requireAuth, asyncHandler(listSubscriptionPlans));
router.get('/summary', requireAuth, asyncHandler(getBillingSummary));
router.post('/coupons/validate', requireAuth, asyncHandler(validatePremiumCoupon));
router.post('/subscriptions', requireAuth, asyncHandler(createPremiumSubscription));
router.post('/subscriptions/verify', requireAuth, asyncHandler(verifyPremiumSubscription));
router.post('/subscriptions/:subscriptionId/change', requireAuth, asyncHandler(changePremiumSubscription));
router.post('/subscriptions/:subscriptionId/cancel', requireAuth, asyncHandler(cancelPremiumSubscription));
router.post('/premium/order', requireAuth, asyncHandler(createPremiumOrder));
router.post('/premium/verify', requireAuth, asyncHandler(verifyPremiumPayment));

export default router;