import { Router } from 'express';
import { accessToken, currentUser, login, logout, refreshToken, register, updateProfile } from '../controllers/userController.js';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { requireAuth } from '../middlewares/authMiddleware.js';
import multer from 'multer';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const router = Router();

router.post('/register', asyncHandler(register));
router.post('/login', asyncHandler(login));
router.post('/refresh-token', asyncHandler(refreshToken));
router.post('/logout', requireAuth, asyncHandler(logout));
router.get('/access-token', requireAuth, asyncHandler(accessToken));
router.get('/me', requireAuth, asyncHandler(currentUser));
router.put('/profile/:userId', requireAuth, upload.single('coverimage'), asyncHandler(updateProfile));

export default router;