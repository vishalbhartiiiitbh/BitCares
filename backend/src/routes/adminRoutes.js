import { Router } from 'express';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { requireAdmin, requireAuth, requirePrimaryAdmin } from '../middlewares/authMiddleware.js';
import { broadcastProductUpdate, createBillingCoupon, createSubAdmin, deleteSubAdmin, getAdminDashboard, listAdminUsers, listBillingCoupons, listSubAdmins, updateAdminSettings, updateBillingCoupon, updateUserPlan } from '../controllers/adminController.js';
import { downloadContactReportAttachment, listContactReports, updateContactReport } from '../controllers/contactController.js';

const router = Router();
router.use(requireAuth, requireAdmin);
router.get('/dashboard', asyncHandler(getAdminDashboard));
router.put('/settings', asyncHandler(updateAdminSettings));
router.get('/users', asyncHandler(listAdminUsers));
router.patch('/users/:userId/plan', asyncHandler(updateUserPlan));
router.get('/coupons', asyncHandler(listBillingCoupons));
router.post('/coupons', asyncHandler(createBillingCoupon));
router.patch('/coupons/:couponId', asyncHandler(updateBillingCoupon));
router.get('/enquiries', asyncHandler(listContactReports));
router.patch('/enquiries/:reportId', asyncHandler(updateContactReport));
router.get('/enquiries/:reportId/attachments/:attachmentId', asyncHandler(downloadContactReportAttachment));
router.post('/broadcasts', asyncHandler(broadcastProductUpdate));
router.get('/sub-admins', requirePrimaryAdmin, asyncHandler(listSubAdmins));
router.post('/sub-admins', requirePrimaryAdmin, asyncHandler(createSubAdmin));
router.delete('/sub-admins/:userId', requirePrimaryAdmin, asyncHandler(deleteSubAdmin));

export default router;