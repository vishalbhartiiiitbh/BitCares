import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { query } from '../db/index.js';
import { deleteImageByUrl, uploadImageBuffer } from '../config/cloudinary.js';

const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax' };
const publicUser = (user) => { const value = { ...user }; delete value.password; delete value.refreshToken; return value; };
const makeAccessToken = (user) => jwt.sign({ _id: user._id, email: user.email, username: user.username, fullnamae: user.fullnamae }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: process.env.ACCESS_TOKEN_EXPIRY || '15m' });
const makeRefreshToken = (user) => jwt.sign({ _id: user._id }, process.env.REFRESH_TOKEN_SECRET, { expiresIn: process.env.REFRESH_TOKEN_EXPIRY || '10d' });
const setCookies = (res, tokens) => { res.cookie('accessToken', tokens.accessToken, { ...cookieOptions, maxAge: 15 * 60 * 1000 }); res.cookie('refreshToken', tokens.refreshToken, { ...cookieOptions, maxAge: 10 * 24 * 60 * 60 * 1000 }); };
const tokenResponse = (user) => { const tokens = { accessToken: makeAccessToken(user), refreshToken: makeRefreshToken(user), tokenType: 'Bearer' }; return { ...tokens, user: publicUser(user) }; };

export const register = async (req, res) => {
  const { username, email, fullnamae, password, phone, coverimage } = req.body;
  if (!username || !email || !fullnamae || !password) throw Object.assign(new Error('username, email, fullnamae, and password are required'), { statusCode: 400 });
  const existing = await query('SELECT id FROM users WHERE username = $1 OR email = $2', [username.toLowerCase(), email.toLowerCase()]);
  if (existing.rowCount) throw Object.assign(new Error('Username or email already exists'), { statusCode: 409 });
  const hash = await bcrypt.hash(password, 12);
  const result = await query('INSERT INTO users (username, email, fullnamae, password, phone, coverimage) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id AS "_id", username, email, fullnamae, phone, coverimage, created_at AS "createdAt"', [username, email, fullnamae, hash, phone || null, coverimage || null]);
  const data = tokenResponse(result.rows[0]);
  await query('UPDATE users SET refresh_token = $1 WHERE id = $2', [data.refreshToken, data.user._id]);
  setCookies(res, data);
  res.status(201).json({ data });
};

export const login = async (req, res) => {
  const { email, username, password } = req.body;
  if ((!email && !username) || !password) throw Object.assign(new Error('Email or username and password are required'), { statusCode: 400 });
  const key = (email || username).toLowerCase();
  const result = await query('SELECT id AS "_id", username, email, fullnamae, phone, coverimage, password, created_at AS "createdAt" FROM users WHERE email = $1 OR username = $1', [key]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password))) throw Object.assign(new Error('Invalid credentials'), { statusCode: 401 });
  const data = tokenResponse(user);
  await query('UPDATE users SET refresh_token = $1 WHERE id = $2', [data.refreshToken, user._id]);
  setCookies(res, data);
  res.json({ data });
};

export const logout = async (req, res) => { await query('UPDATE users SET refresh_token = NULL WHERE id = $1', [req.user._id]); res.clearCookie('accessToken', cookieOptions); res.clearCookie('refreshToken', cookieOptions); res.json({ data: { message: 'Logged out successfully' } }); };
export const refreshToken = async (req, res) => { const incoming = req.cookies?.refreshToken || req.body.refreshToken; if (!incoming) throw Object.assign(new Error('Refresh token is required'), { statusCode: 401 }); const decoded = jwt.verify(incoming, process.env.REFRESH_TOKEN_SECRET); const result = await query('SELECT id AS "_id", username, email, fullnamae, phone, coverimage, created_at AS "createdAt" FROM users WHERE id = $1 AND refresh_token = $2', [decoded._id, incoming]); if (!result.rowCount) throw Object.assign(new Error('Invalid refresh token'), { statusCode: 401 }); const data = tokenResponse(result.rows[0]); await query('UPDATE users SET refresh_token = $1 WHERE id = $2', [data.refreshToken, decoded._id]); setCookies(res, data); res.json({ data: { accessToken: data.accessToken, refreshToken: data.refreshToken, tokenType: data.tokenType } }); };
export const accessToken = async (req, res) => res.json({ data: { accessToken: makeAccessToken(req.user), tokenType: 'Bearer' } });
export const currentUser = async (req, res) => res.json({ data: { user: req.user } });

const assertCurrentPassword = async (userId, currentPassword) => {
  if (typeof currentPassword !== 'string' || !currentPassword) {
    throw Object.assign(new Error('Current password is required'), { statusCode: 400 });
  }
  const result = await query('SELECT password FROM users WHERE id = $1', [userId]);
  if (!result.rows[0] || !(await bcrypt.compare(currentPassword, result.rows[0].password))) {
    throw Object.assign(new Error('Current password is incorrect'), { statusCode: 401 });
  }
};

export const verifyCurrentPassword = async (req, res) => {
  await assertCurrentPassword(req.user._id, req.body?.currentPassword);
  res.json({ data: { verified: true } });
};

export const checkUsernameAvailability = async (req, res) => {
  if (typeof req.query.username !== 'string') {
    throw Object.assign(new Error('Enter a username of 1 to 40 characters'), { statusCode: 400 });
  }
  const username = req.query.username.trim();
  if (!username || username.length > 40) {
    throw Object.assign(new Error('Enter a username of 1 to 40 characters'), { statusCode: 400 });
  }
  const result = await query(
    'SELECT EXISTS (SELECT 1 FROM users WHERE LOWER(username) = LOWER($1) AND id <> $2) AS taken',
    [username, req.user._id],
  );
  res.json({ data: { available: !result.rows[0].taken } });
};

export const updateProfile = async (req, res) => {
  if (req.params.userId !== req.user._id) throw Object.assign(new Error('You can only update your own profile'), { statusCode: 403 });

  const { username, email, fullnamae, currentPassword, newPassword, phone, coverimage } = req.body || {};
  const values = {};
  if (username?.trim()) values.username = username.trim().toLowerCase();
  if (email?.trim()) values.email = email.trim().toLowerCase();
  if (fullnamae?.trim()) values.fullnamae = fullnamae.trim();
  if (phone !== undefined) values.phone = phone.trim();
  if (coverimage?.trim()) values.coverimage = coverimage.trim();
  if (values.username && values.username !== req.user.username.toLowerCase()) {
    const usernameResult = await query(
      'SELECT EXISTS (SELECT 1 FROM users WHERE LOWER(username) = $1 AND id <> $2) AS taken',
      [values.username, req.user._id],
    );
    if (usernameResult.rows[0].taken) {
      throw Object.assign(new Error('That username is already taken. Please choose a different one.'), { statusCode: 409 });
    }
  }
  const passwordUpdateRequested = currentPassword !== undefined || newPassword !== undefined;
  if (passwordUpdateRequested) {
    if (typeof newPassword !== 'string' || !newPassword) {
      throw Object.assign(new Error('Current password and new password are required'), { statusCode: 400 });
    }
    if (newPassword.length < 8) {
      throw Object.assign(new Error('New password must be at least 8 characters'), { statusCode: 400 });
    }
    await assertCurrentPassword(req.user._id, currentPassword);
    values.password = await bcrypt.hash(newPassword, 12);
  }
  if (req.file) values.coverimage = await uploadImageBuffer(req.file.buffer);

  if (!Object.keys(values).length) throw Object.assign(new Error('At least one profile field is required'), { statusCode: 400 });
  const fields = Object.keys(values);
  const params = fields.map((field) => values[field]);
  const assignments = fields.map((field, index) => `${field} = $${index + 1}`).join(', ');
  params.push(req.user._id);
  let result;
  try {
    result = await query(`UPDATE users SET ${assignments} WHERE id = $${params.length} RETURNING id AS "_id", username, email, fullnamae, phone, coverimage, created_at AS "createdAt"`, params);
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'users_username_key') {
      throw Object.assign(new Error('That username is already taken. Please choose a different one.'), { statusCode: 409 });
    }
    throw error;
  }

  let cleanupWarning;
  if (req.file && req.user.coverimage && req.user.coverimage !== result.rows[0].coverimage) {
    try {
      await deleteImageByUrl(req.user.coverimage);
    } catch {
      cleanupWarning = 'Profile photo updated, but the previous photo could not be removed from Cloudinary.';
    }
  }
  res.json({ data: { user: result.rows[0], cleanupWarning } });
};
