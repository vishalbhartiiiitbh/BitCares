import bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { query, withTransaction } from '../db/index.js';
import { deleteImageByUrl, uploadImageBuffer } from '../config/cloudinary.js';
import { sendPasswordResetEmail } from '../services/emailService.js';

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
  const result = await query('INSERT INTO users (username, email, fullnamae, password, phone, coverimage) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id AS "_id", username, email, fullnamae, phone, coverimage, default_currency AS "defaultCurrency", created_at AS "createdAt"', [username, email, fullnamae, hash, phone || null, coverimage || null]);
  const data = tokenResponse(result.rows[0]);
  await query('UPDATE users SET refresh_token = $1 WHERE id = $2', [data.refreshToken, data.user._id]);
  setCookies(res, data);
  res.status(201).json({ data });
};

export const login = async (req, res) => {
  const { email, username, password } = req.body;
  if ((!email && !username) || !password) throw Object.assign(new Error('Email or username and password are required'), { statusCode: 400 });
  const key = (email || username).toLowerCase();
  const result = await query('SELECT id AS "_id", username, email, fullnamae, phone, coverimage, default_currency AS "defaultCurrency", password, created_at AS "createdAt", login_locked_until > NOW() AS "isLoginLocked" FROM users WHERE email = $1 OR username = $1', [key]);
  const user = result.rows[0];
  if (!user) throw Object.assign(new Error('Invalid credentials'), { statusCode: 401 });
  if (user.isLoginLocked) {
    throw Object.assign(new Error('Account temporarily locked after too many failed attempts. Reset your password or try again in 30 minutes.'), { statusCode: 423 });
  }
  if (!(await bcrypt.compare(password, user.password))) {
    const failure = await query(
      `UPDATE users
          SET login_failed_attempts = CASE
                WHEN login_failure_window_started_at IS NULL
                  OR login_failure_window_started_at <= NOW() - INTERVAL '5 minutes'
                THEN 1 ELSE login_failed_attempts + 1
              END,
              login_failure_window_started_at = CASE
                WHEN login_failure_window_started_at IS NULL
                  OR login_failure_window_started_at <= NOW() - INTERVAL '5 minutes'
                THEN NOW() ELSE login_failure_window_started_at
              END,
              login_locked_until = CASE
                WHEN (CASE
                  WHEN login_failure_window_started_at IS NULL
                    OR login_failure_window_started_at <= NOW() - INTERVAL '5 minutes'
                  THEN 1 ELSE login_failed_attempts + 1
                END) >= 5
                THEN NOW() + INTERVAL '30 minutes'
                ELSE login_locked_until
              END
        WHERE id = $1
        RETURNING login_locked_until > NOW() AS "isLoginLocked"`,
      [user._id],
    );
    if (failure.rows[0].isLoginLocked) {
      throw Object.assign(new Error('Account temporarily locked after too many failed attempts. Reset your password or try again in 30 minutes.'), { statusCode: 423 });
    }
    throw Object.assign(new Error('Invalid credentials'), { statusCode: 401 });
  }
  const data = tokenResponse(user);
  const unlocked = await query(
    `UPDATE users
        SET refresh_token = $1,
            login_failed_attempts = 0,
            login_failure_window_started_at = NULL,
            login_locked_until = NULL
      WHERE id = $2
        AND (login_locked_until IS NULL OR login_locked_until <= NOW())
      RETURNING id`,
    [data.refreshToken, user._id],
  );
  if (!unlocked.rowCount) {
    throw Object.assign(new Error('Account temporarily locked after too many failed attempts. Reset your password or try again in 30 minutes.'), { statusCode: 423 });
  }
  setCookies(res, data);
  res.json({ data });
};

export const forgotPassword = async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!email) throw Object.assign(new Error('Email is required'), { statusCode: 400 });

  const result = await query('SELECT id, email FROM users WHERE LOWER(email) = $1', [email]);
  if (result.rowCount) {
    const user = result.rows[0];
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const allowed = await query(
      `UPDATE users
          SET password_reset_email_count = CASE
                WHEN password_reset_email_window_started_at IS NULL
                  OR password_reset_email_window_started_at <= NOW() - INTERVAL '10 minutes'
                THEN 1 ELSE password_reset_email_count + 1
              END,
              password_reset_email_window_started_at = CASE
                WHEN password_reset_email_window_started_at IS NULL
                  OR password_reset_email_window_started_at <= NOW() - INTERVAL '10 minutes'
                THEN NOW() ELSE password_reset_email_window_started_at
              END,
              password_reset_token_hash = $1,
              password_reset_expires_at = NOW() + INTERVAL '10 minutes'
        WHERE id = $2
          AND (password_reset_email_window_started_at IS NULL
            OR password_reset_email_window_started_at <= NOW() - INTERVAL '10 minutes'
            OR password_reset_email_count < 5)
        RETURNING id`,
      [tokenHash, user.id],
    );

    if (allowed.rowCount) {
      const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
      const resetUrl = `${frontendUrl}/?resetToken=${encodeURIComponent(token)}`;
      try {
        await sendPasswordResetEmail(user.email, resetUrl);
      } catch (error) {
        await query(
          'UPDATE users SET password_reset_token_hash = NULL, password_reset_expires_at = NULL WHERE id = $1 AND password_reset_token_hash = $2',
          [user.id, tokenHash],
        );
        throw error;
      }
    }
  }

  res.json({ data: { message: 'If an account exists for that email, a password reset link has been sent.' } });
};

export const resetPassword = async (req, res) => {
  const { token, password } = req.body || {};
  if (typeof token !== 'string' || !token) {
    throw Object.assign(new Error('A password reset token is required'), { statusCode: 400 });
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw Object.assign(new Error('Password must be at least 8 characters'), { statusCode: 400 });
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');
  const passwordHash = await bcrypt.hash(password, 12);
  await withTransaction(async (client) => {
    const result = await client.query(
      'SELECT id FROM users WHERE password_reset_token_hash = $1 AND password_reset_expires_at > NOW() FOR UPDATE',
      [tokenHash],
    );
    if (!result.rowCount) {
      throw Object.assign(new Error('This password reset link is invalid or has expired'), { statusCode: 400 });
    }

    await client.query(
      `UPDATE users
          SET password = $1,
              password_reset_token_hash = NULL,
              password_reset_expires_at = NULL,
              refresh_token = NULL,
              login_failed_attempts = 0,
              login_failure_window_started_at = NULL,
              login_locked_until = NULL
        WHERE id = $2`,
      [passwordHash, result.rows[0].id],
    );
  });

  res.json({ data: { message: 'Password reset successfully. You can now sign in.' } });
};

export const logout = async (req, res) => { await query('UPDATE users SET refresh_token = NULL WHERE id = $1', [req.user._id]); res.clearCookie('accessToken', cookieOptions); res.clearCookie('refreshToken', cookieOptions); res.json({ data: { message: 'Logged out successfully' } }); };
export const refreshToken = async (req, res) => { const incoming = req.cookies?.refreshToken || req.body.refreshToken; if (!incoming) throw Object.assign(new Error('Refresh token is required'), { statusCode: 401 }); const decoded = jwt.verify(incoming, process.env.REFRESH_TOKEN_SECRET); const result = await query('SELECT id AS "_id", username, email, fullnamae, phone, coverimage, default_currency AS "defaultCurrency", created_at AS "createdAt" FROM users WHERE id = $1 AND refresh_token = $2', [decoded._id, incoming]); if (!result.rowCount) throw Object.assign(new Error('Invalid refresh token'), { statusCode: 401 }); const data = tokenResponse(result.rows[0]); await query('UPDATE users SET refresh_token = $1 WHERE id = $2', [data.refreshToken, decoded._id]); setCookies(res, data); res.json({ data: { accessToken: data.accessToken, refreshToken: data.refreshToken, tokenType: data.tokenType } }); };
export const accessToken = async (req, res) => res.json({ data: { accessToken: makeAccessToken(req.user), tokenType: 'Bearer' } });
export const currentUser = async (req, res) => res.json({ data: { user: req.user } });

export const listNotifications = async (req, res) => {
  const result = await query(
    `SELECT id AS "_id", group_id AS "groupId", expense_id AS "expenseId",
            message, notification_type AS "notificationType",
            created_by AS "createdBy", created_at AS "createdAt", read_at AS "readAt"
     FROM notifications n
     WHERE user_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM groups g WHERE g.id = n.group_id AND g.is_friend_ledger
       )
     ORDER BY created_at DESC`,
    [req.user._id],
  );
  res.json({ data: result.rows });
};

export const markNotificationsRead = async (req, res) => {
  const result = await query(
    'UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL',
    [req.user._id],
  );
  res.json({ data: { markedRead: result.rowCount } });
};

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

  const { username, email, fullnamae, currentPassword, newPassword, phone, coverimage, defaultCurrency } = req.body || {};
  const values = {};
  if (username?.trim()) values.username = username.trim().toLowerCase();
  if (email?.trim()) values.email = email.trim().toLowerCase();
  if (fullnamae?.trim()) values.fullnamae = fullnamae.trim();
  if (phone !== undefined) values.phone = phone.trim();
  if (coverimage?.trim()) values.coverimage = coverimage.trim();
  if (defaultCurrency !== undefined) {
    if (!['INR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD'].includes(defaultCurrency)) {
      throw Object.assign(new Error('Choose a supported default currency'), { statusCode: 400 });
    }
    values.default_currency = defaultCurrency;
  }
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
    result = await query(`UPDATE users SET ${assignments} WHERE id = $${params.length} RETURNING id AS "_id", username, email, fullnamae, phone, coverimage, default_currency AS "defaultCurrency", created_at AS "createdAt"`, params);
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
