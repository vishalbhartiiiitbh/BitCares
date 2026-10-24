import { Router } from 'express';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { requireAdmin, requireAuth, requirePrimaryAdmin } from '../middlewares/authMiddleware.js';
import { broadcastProductUpdate, createSubAdmin, deleteSubAdmin, getAdminDashboard, listAdminUsers, listSubAdmins, updateAdminSettings, updateUserPlan } from '../controllers/adminController.js';

const router = Router();
router.use(requireAuth, requireAdmin);
router.get('/dashboard', asyncHandler(getAdminDashboard));
router.put('/settings', asyncHandler(updateAdminSettings));
router.get('/users', asyncHandler(listAdminUsers));
router.patch('/users/:userId/plan', asyncHandler(updateUserPlan));
router.post('/broadcasts', asyncHandler(broadcastProductUpdate));
router.get('/sub-admins', requirePrimaryAdmin, asyncHandler(listSubAdmins));
router.post('/sub-admins', requirePrimaryAdmin, asyncHandler(createSubAdmin));
router.delete('/sub-admins/:userId', requirePrimaryAdmin, asyncHandler(deleteSubAdmin));

export default router;