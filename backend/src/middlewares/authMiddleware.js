import jwt from 'jsonwebtoken';
import { query } from '../db/index.js';

const getAccessToken = (req) => {
  const authorization = req.headers.authorization;
  // Prefer an explicit bearer token, while retaining cookie auth for browser requests.
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7);
  return req.cookies?.accessToken;
};

export const requireAuth = async (req, _res, next) => {
  try {
    const token = getAccessToken(req);
    if (!token) return next(Object.assign(new Error('Access token is required'), { statusCode: 401 }));
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    // Load the current account record so deleted users and changed profile data take effect immediately.
    const { rows } = await query('SELECT id AS "_id", username, email, fullnamae, phone, coverimage, default_currency AS "defaultCurrency", username_change_count AS "usernameChangeCount", role, plan, premium_until AS "premiumUntil", created_at AS "createdAt" FROM users WHERE id = $1', [decoded._id]);
    const user = rows[0];
    if (!user) return next(Object.assign(new Error('User not found'), { statusCode: 401 }));
    req.user = user;
    next();
  } catch {
    next(Object.assign(new Error('Invalid or expired access token'), { statusCode: 401 }));
  }
};

export const requireAdmin = (req, _res, next) => {
  if (!['admin', 'sub_admin'].includes(req.user?.role)) {
    return next(Object.assign(new Error('Administrator access is required'), { statusCode: 403 }));
  }
  next();
};

export const requirePrimaryAdmin = (req, _res, next) => {
  if (req.user?.role !== 'admin') {
    return next(Object.assign(new Error('Only the primary administrator can manage administrators'), { statusCode: 403 }));
  }
  next();
};