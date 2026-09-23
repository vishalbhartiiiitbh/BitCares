import jwt from 'jsonwebtoken';
import { query } from '../db/index.js';

const getAccessToken = (req) => {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7);
  return req.cookies?.accessToken;
};

export const requireAuth = async (req, _res, next) => {
  try {
    const token = getAccessToken(req);
    if (!token) return next(Object.assign(new Error('Access token is required'), { statusCode: 401 }));
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    const { rows } = await query('SELECT id AS "_id", username, email, fullnamae, phone, coverimage, created_at AS "createdAt" FROM users WHERE id = $1', [decoded._id]);
    const user = rows[0];
    if (!user) return next(Object.assign(new Error('User not found'), { statusCode: 401 }));
    req.user = user;
    next();
  } catch {
    next(Object.assign(new Error('Invalid or expired access token'), { statusCode: 401 }));
  }
};