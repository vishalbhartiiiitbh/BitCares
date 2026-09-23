import { Router } from 'express';
import { accessToken, currentUser, login, logout, refreshToken, register } from '../controllers/userController.js';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { requireAuth } from '../middlewares/authMiddleware.js';

const router = Router();

router.post('/register', asyncHandler(register));
router.post('/login', asyncHandler(login));
router.post('/refresh-token', asyncHandler(refreshToken));
router.post('/logout', requireAuth, asyncHandler(logout));
router.get('/access-token', requireAuth, asyncHandler(accessToken));
router.get('/me', requireAuth, asyncHandler(currentUser));

export default router;