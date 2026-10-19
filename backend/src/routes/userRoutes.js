import { Router } from 'express';
import { accessToken, changeEmail, checkUsernameAvailability, currentUser, deleteAccount, forgotPassword, listNotifications, login, logout, markNotificationsRead, refreshToken, register, resetPassword, sendAccountDeletionCode, sendEmailChangeCodes, sendRegistrationCode, updateProfile, verifyCurrentPassword, verifyRegistrationCode } from '../controllers/userController.js';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { requireAuth } from '../middlewares/authMiddleware.js';
import multer from 'multer';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const router = Router();

router.post('/register', asyncHandler(register));
router.post('/register/send-code', asyncHandler(sendRegistrationCode));
router.post('/register/verify-code', asyncHandler(verifyRegistrationCode));
router.post('/login', asyncHandler(login));
router.post('/forgot-password', asyncHandler(forgotPassword));
router.post('/reset-password', asyncHandler(resetPassword));
router.post('/refresh-token', asyncHandler(refreshToken));
router.post('/logout', requireAuth, asyncHandler(logout));
router.get('/access-token', requireAuth, asyncHandler(accessToken));
router.get('/me', requireAuth, asyncHandler(currentUser));
router.get('/notifications', requireAuth, asyncHandler(listNotifications));
router.patch('/notifications/read', requireAuth, asyncHandler(markNotificationsRead));
router.post('/profile/verify-password', requireAuth, asyncHandler(verifyCurrentPassword));
router.post('/profile/email-change/send-codes', requireAuth, asyncHandler(sendEmailChangeCodes));
router.post('/profile/email-change/verify', requireAuth, asyncHandler(changeEmail));
router.post('/profile/delete-account/send-code', requireAuth, asyncHandler(sendAccountDeletionCode));
router.delete('/profile/account', requireAuth, asyncHandler(deleteAccount));
router.get('/profile/username-availability', requireAuth, asyncHandler(checkUsernameAvailability));
router.put('/profile/:userId', requireAuth, upload.single('coverimage'), asyncHandler(updateProfile));

export default router;