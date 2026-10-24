import bcrypt from 'bcrypt';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { query, withTransaction } from '../db/index.js';
import { deleteImageByUrl, uploadImageBuffer } from '../config/cloudinary.js';
import { sendEmailVerificationCode, sendPasswordResetEmail, sendWelcomeEmail } from '../services/emailService.js';
import { EMAIL_NOTIFICATION_PREFERENCES } from '../services/emailNotificationService.js';
import { getAvailableCurrencies } from '../services/exchangeRateService.js';

const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax' };
const publicUser = (user) => { const value = { ...user }; delete value.password; delete value.refreshToken; return value; };
const makeAccessToken = (user) => jwt.sign({ _id: user._id, email: user.email, username: user.username, fullnamae: user.fullnamae }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: process.env.ACCESS_TOKEN_EXPIRY || '15m' });
const makeRefreshToken = (user) => jwt.sign({ _id: user._id }, process.env.REFRESH_TOKEN_SECRET, { expiresIn: process.env.REFRESH_TOKEN_EXPIRY || '10d' });
const setCookies = (res, tokens) => { res.cookie('accessToken', tokens.accessToken, { ...cookieOptions, maxAge: 15 * 60 * 1000 }); res.cookie('refreshToken', tokens.refreshToken, { ...cookieOptions, maxAge: 10 * 24 * 60 * 60 * 1000 }); };
const tokenResponse = (user) => { const tokens = { accessToken: makeAccessToken(user), refreshToken: makeRefreshToken(user), tokenType: 'Bearer' }; return { ...tokens, user: publicUser(user) }; };
const hashVerificationCode = (email, purpose, salt, code) =>
  createHmac('sha256', process.env.ACCESS_TOKEN_SECRET).update(`${email}:${purpose}:${salt}:${code}`).digest('hex');

const sendEmailCode = async (email, purpose) => {
  // Store only a salted, keyed hash so a database read cannot reveal an active email code.
  const salt = randomBytes(16).toString('hex');
  const code = String(randomInt(100000, 1000000));
  const codeHash = hashVerificationCode(email, purpose, salt, code);
  const result = await query(
    `INSERT INTO account_email_codes
       (email, purpose, code_hash, code_salt, code_expires_at, failed_attempts, sent_count, send_window_started_at, verified_token_hash, verified_expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '10 minutes', 0, 1, NOW(), NULL, NULL)
     ON CONFLICT (email, purpose) DO UPDATE
       SET code_hash = EXCLUDED.code_hash,
           code_salt = EXCLUDED.code_salt,
           code_expires_at = EXCLUDED.code_expires_at,
           failed_attempts = 0,
           sent_count = CASE
             WHEN account_email_codes.send_window_started_at <= NOW() - INTERVAL '10 minutes' THEN 1
             ELSE account_email_codes.sent_count + 1
           END,
           send_window_started_at = CASE
             WHEN account_email_codes.send_window_started_at <= NOW() - INTERVAL '10 minutes' THEN NOW()
             ELSE account_email_codes.send_window_started_at
           END,
           verified_token_hash = NULL,
           verified_expires_at = NULL
       WHERE account_email_codes.send_window_started_at IS NULL
          OR account_email_codes.send_window_started_at <= NOW() - INTERVAL '10 minutes'
          OR account_email_codes.sent_count < 5
     RETURNING email`,
    [email, purpose, codeHash, salt],
  );
  if (!result.rowCount) {
    throw Object.assign(new Error('Too many verification emails requested. Please try again in 10 minutes.'), { statusCode: 429 });
  }

  try {
    await sendEmailVerificationCode(email, code, purpose);
  } catch (error) {
    await query(
      'UPDATE account_email_codes SET code_hash = NULL, code_salt = NULL, code_expires_at = NULL WHERE email = $1 AND purpose = $2 AND code_hash = $3',
      [email, purpose, codeHash],
    );
    throw error;
  }
};

const matchingCode = (row, code) => {
  const actual = Buffer.from(hashVerificationCode(row.email, row.purpose, row.code_salt, code), 'hex');
  const expected = Buffer.from(row.code_hash || '', 'hex');
  // Constant-time comparison prevents timing from revealing how much of a code matched.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export const sendRegistrationCode = async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!email) throw Object.assign(new Error('Email is required'), { statusCode: 400 });
  const existing = await query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
  if (existing.rowCount) throw Object.assign(new Error('An account already exists for this email'), { statusCode: 409 });
  await sendEmailCode(email, 'signup');
  res.json({ data: { message: 'A verification code has been sent to your email. It expires in 10 minutes.' } });
};

export const verifyRegistrationCode = async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!email || !/^\d{6}$/.test(code)) {
    throw Object.assign(new Error('Enter your email and the 6-digit verification code'), { statusCode: 400 });
  }

  const verificationToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(verificationToken).digest('hex');
  const outcome = await withTransaction(async (client) => {
    const result = await client.query(
      'SELECT email, purpose, code_hash, code_salt, code_expires_at, failed_attempts FROM account_email_codes WHERE email = $1 AND purpose = $2 FOR UPDATE',
      [email, 'signup'],
    );
    const row = result.rows[0];
    if (!row || !row.code_hash || new Date(row.code_expires_at) <= new Date() || row.failed_attempts >= 5) {
      return { error: 'This verification code is invalid or has expired. Request a new code.' };
    }
    if (!matchingCode(row, code)) {
      await client.query(
        'UPDATE account_email_codes SET failed_attempts = failed_attempts + 1 WHERE email = $1 AND purpose = $2',
        [email, 'signup'],
      );
      return { error: 'Incorrect verification code' };
    }
    await client.query(
      // Consume the one-time code and replace it with a short-lived registration token hash.
      `UPDATE account_email_codes
          SET code_hash = NULL, code_salt = NULL, code_expires_at = NULL,
              verified_token_hash = $1, verified_expires_at = NOW() + INTERVAL '10 minutes'
        WHERE email = $2 AND purpose = $3`,
      [tokenHash, email, 'signup'],
    );
    return { verified: true };
  });

  if (outcome.error) throw Object.assign(new Error(outcome.error), { statusCode: 400 });
  res.json({ data: { verified: true, verificationToken } });
};

export const register = async (req, res) => {
  const { username, fullnamae, password, phone, coverimage, verificationToken } = req.body || {};
  const referralCode = typeof req.body?.referralCode === 'string' ? req.body.referralCode.trim() : '';
  const referrerUsername = typeof req.body?.referrerUsername === 'string' ? req.body.referrerUsername.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!username || !email || !fullnamae || !password || typeof verificationToken !== 'string') {
    throw Object.assign(new Error('username, email, fullnamae, password, and verified email are required'), { statusCode: 400 });
  }
  if (password.length < 8) throw Object.assign(new Error('Password must be at least 8 characters'), { statusCode: 400 });
  const hash = await bcrypt.hash(password, 12);
  const verificationHash = createHash('sha256').update(verificationToken).digest('hex');
  let result;
  try {
    result = await withTransaction(async (client) => {
      const verification = await client.query(
        `SELECT email FROM account_email_codes
          WHERE email = $1 AND purpose = 'signup'
            AND verified_token_hash = $2 AND verified_expires_at > NOW()
          FOR UPDATE`,
        [email, verificationHash],
      );
      if (!verification.rowCount) {
        return { error: 'Verify your email before creating an account. The verification may have expired.' };
      }

      const existing = await client.query(
        'SELECT id FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = $2',
        [username, email],
      );
      if (existing.rowCount) return { error: 'Username or email already exists', statusCode: 409 };

      let referrerId = null;
      if (referralCode || referrerUsername) {
        if (!/^[A-Za-z0-9_-]{32}$/.test(referralCode)) {
          return { error: 'The referral link is incomplete. Ask your friend to share a new link.' };
        }
        const referrer = await client.query(
          'SELECT user_id AS "userId" FROM referral_codes WHERE code = $1',
          [referralCode],
        );
        if (!referrer.rowCount) {
          return { error: 'This referral link is invalid. Ask your friend to share a new link.' };
        }
        referrerId = referrer.rows[0].userId;
      }

      const inserted = await client.query(
        'INSERT INTO users (username, email, fullnamae, password, phone, coverimage) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id AS "_id", username, email, fullnamae, phone, coverimage, default_currency AS "defaultCurrency", username_change_count AS "usernameChangeCount", role, plan, premium_until AS "premiumUntil", created_at AS "createdAt"',
        [username, email, fullnamae, hash, phone || null, coverimage || null],
      );
      if (referrerId) {
        const [userLow, userHigh] = [referrerId, inserted.rows[0]._id].sort();
        await client.query(
          'INSERT INTO friendships (user_low, user_high) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [userLow, userHigh],
        );
        await client.query(
          'INSERT INTO referrals (referrer_user_id, referred_user_id) VALUES ($1, $2)',
          [referrerId, inserted.rows[0]._id],
        );
        await client.query(
          `INSERT INTO referral_points (user_id, referred_user_id)
           VALUES ($1, $2), ($2, $2)`,
          [referrerId, inserted.rows[0]._id],
        );
      }
      await client.query('DELETE FROM account_email_codes WHERE email = $1 AND purpose = $2', [email, 'signup']);
      return { user: inserted.rows[0], referred: Boolean(referrerId) };
    });
  } catch (error) {
    if (error.code === '23505') {
      throw Object.assign(new Error('Username or email already exists'), { statusCode: 409 });
    }
    throw error;
  }
  if (result.error) throw Object.assign(new Error(result.error), { statusCode: result.statusCode || 400 });
  const user = result.user;
  const data = tokenResponse(user);
  await query('UPDATE users SET refresh_token = $1 WHERE id = $2', [data.refreshToken, data.user._id]);
  setCookies(res, data);
  if (result.referred) data.referralMessage = 'Referral confirmed! You and your friend each earned 10 points.';
  try {
    await sendWelcomeEmail(user.email, user.fullnamae);
  } catch (error) {
    console.error(`Account was created, but the welcome email could not be sent to ${user.email}:`, error);
  }
  res.status(201).json({ data });
};

export const login = async (req, res) => {
  const { email, username, password } = req.body;
  if ((!email && !username) || !password) throw Object.assign(new Error('Email or username and password are required'), { statusCode: 400 });
  const key = (email || username).toLowerCase();
  const result = await query('SELECT id AS "_id", username, email, fullnamae, phone, coverimage, default_currency AS "defaultCurrency", username_change_count AS "usernameChangeCount", role, plan, premium_until AS "premiumUntil", password, created_at AS "createdAt", login_locked_until > NOW() AS "isLoginLocked" FROM users WHERE email = $1 OR username = $1', [key]);
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

export const sendAccountDeletionCode = async (req, res) => {
  await sendEmailCode(req.user.email.toLowerCase(), 'delete_account');
  res.json({ data: { message: 'A deletion confirmation code has been sent to your email. It expires in 10 minutes.' } });
};

export const sendEmailChangeCodes = async (req, res) => {
  const newEmail = typeof req.body?.newEmail === 'string' ? req.body.newEmail.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    throw Object.assign(new Error('Enter a valid new email address'), { statusCode: 400 });
  }
  if (newEmail === req.user.email.toLowerCase()) {
    throw Object.assign(new Error('The new email must be different from your current email'), { statusCode: 400 });
  }
  const existing = await query('SELECT id FROM users WHERE LOWER(email) = $1', [newEmail]);
  if (existing.rowCount) {
    throw Object.assign(new Error('This email address is already linked to an account'), { statusCode: 409 });
  }

  await sendEmailCode(req.user.email.toLowerCase(), 'email_change_old');
  await sendEmailCode(newEmail, 'email_change_new');
  res.json({ data: { message: `Verification codes have been sent to ${req.user.email} and ${newEmail}. Both codes expire in 10 minutes.` } });
};

export const changeEmail = async (req, res) => {
  const newEmail = typeof req.body?.newEmail === 'string' ? req.body.newEmail.trim().toLowerCase() : '';
  const oldCode = typeof req.body?.oldCode === 'string' ? req.body.oldCode.trim() : '';
  const newCode = typeof req.body?.newCode === 'string' ? req.body.newCode.trim() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail) || !/^\d{6}$/.test(oldCode) || !/^\d{6}$/.test(newCode)) {
    throw Object.assign(new Error('Enter a valid new email and both 6-digit verification codes'), { statusCode: 400 });
  }

  const oldEmail = req.user.email.toLowerCase();
  if (newEmail === oldEmail) {
    throw Object.assign(new Error('The new email must be different from your current email'), { statusCode: 400 });
  }

  let outcome;
  try {
    outcome = await withTransaction(async (client) => {
      const available = await client.query(
        'SELECT id FROM users WHERE LOWER(email) = $1 AND id <> $2',
        [newEmail, req.user._id],
      );
      if (available.rowCount) return { error: 'This email address is already linked to an account', statusCode: 409 };

      const codes = await client.query(
        `SELECT email, purpose, code_hash, code_salt, code_expires_at, failed_attempts
           FROM account_email_codes
          WHERE (email = $1 AND purpose = 'email_change_old')
             OR (email = $2 AND purpose = 'email_change_new')
          ORDER BY email, purpose
          FOR UPDATE`,
        [oldEmail, newEmail],
      );
      const oldVerification = codes.rows.find((row) => row.purpose === 'email_change_old');
      const newVerification = codes.rows.find((row) => row.purpose === 'email_change_new');
      for (const [row, code] of [[oldVerification, oldCode], [newVerification, newCode]]) {
        if (!row || !row.code_hash || new Date(row.code_expires_at) <= new Date() || row.failed_attempts >= 5) {
          return { error: 'A verification code is invalid or has expired. Request new codes.' };
        }
        if (!matchingCode(row, code)) {
          await client.query(
            'UPDATE account_email_codes SET failed_attempts = failed_attempts + 1 WHERE email = $1 AND purpose = $2',
            [row.email, row.purpose],
          );
          return { error: 'One of the verification codes is incorrect' };
        }
      }

      const updated = await client.query(
        `UPDATE users
            SET email = $1
          WHERE id = $2
          RETURNING id AS "_id", username, email, fullnamae, phone, coverimage,
                    default_currency AS "defaultCurrency", created_at AS "createdAt"`,
        [newEmail, req.user._id],
      );
      await client.query(
        `UPDATE email_notification_outbox
            SET recipient_email = $1
          WHERE user_id = $2 AND sent_at IS NULL`,
        [newEmail, req.user._id],
      );
      await client.query(
        `INSERT INTO email_notification_outbox (user_id, recipient_email, subject, body)
         VALUES ($1, $2, $3, $4)`,
        [
          req.user._id,
          newEmail,
          'Your Splitpayerly email address was updated',
          `Your Splitpayerly account email address was successfully changed from ${oldEmail} to ${newEmail}.\n\nIf you did not make this change, please contact Splitpayerly support immediately.`,
        ],
      );
      await client.query(
        `DELETE FROM account_email_codes
          WHERE (email = $1 AND purpose = 'email_change_old')
             OR (email = $2 AND purpose = 'email_change_new')`,
        [oldEmail, newEmail],
      );
      return { user: updated.rows[0] };
    });
  } catch (error) {
    if (error.code === '23505') {
      throw Object.assign(new Error('This email address is already linked to an account'), { statusCode: 409 });
    }
    throw error;
  }

  if (outcome.error) throw Object.assign(new Error(outcome.error), { statusCode: outcome.statusCode || 400 });
  res.json({ data: { user: outcome.user, message: 'Email address updated successfully.' } });
};

export const deleteAccount = async (req, res) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!/^\d{6}$/.test(code)) {
    throw Object.assign(new Error('Enter the 6-digit confirmation code sent to your email'), { statusCode: 400 });
  }

  const outcome = await withTransaction(async (client) => {
    const result = await client.query(
      `SELECT email, purpose, code_hash, code_salt, code_expires_at, failed_attempts
         FROM account_email_codes
        WHERE email = $1 AND purpose = $2
        FOR UPDATE`,
      [req.user.email.toLowerCase(), 'delete_account'],
    );
    const row = result.rows[0];
    if (!row || !row.code_hash || new Date(row.code_expires_at) <= new Date() || row.failed_attempts >= 5) {
      return { error: 'This confirmation code is invalid or has expired. Request a new code.' };
    }
    if (!matchingCode(row, code)) {
      await client.query(
        'UPDATE account_email_codes SET failed_attempts = failed_attempts + 1 WHERE email = $1 AND purpose = $2',
        [row.email, 'delete_account'],
      );
      return { error: 'Incorrect confirmation code' };
    }

    const userId = req.user._id;
    await client.query(
      `DELETE FROM groups
        WHERE created_by = $1
           OR id IN (
             SELECT group_id FROM friend_ledgers
              WHERE user_low = $1 OR user_high = $1
           )`,
      [userId],
    );
    await client.query(
      `DELETE FROM expenses e
        WHERE e.paid_by = $1
           OR EXISTS (SELECT 1 FROM expense_splits s WHERE s.expense_id = e.id AND s.user_id = $1)
           OR EXISTS (
             SELECT 1 FROM expense_items i
             JOIN expense_item_splits s ON s.item_id = i.id
              WHERE i.expense_id = e.id AND s.user_id = $1
           )`,
      [userId],
    );
    await client.query('DELETE FROM group_activity WHERE actor_id = $1', [userId]);
    await client.query('DELETE FROM group_whiteboards WHERE updated_by = $1', [userId]);
    await client.query('DELETE FROM balances WHERE user1 = $1 OR user2 = $1', [userId]);
    await client.query('DELETE FROM group_settlements WHERE paid_by = $1 OR paid_to = $1', [userId]);
    await client.query('DELETE FROM friend_settlements WHERE paid_by = $1 OR paid_to = $1', [userId]);
    await client.query('DELETE FROM account_email_codes WHERE email = $1', [row.email]);
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    return { deleted: true };
  });

  if (outcome.error) throw Object.assign(new Error(outcome.error), { statusCode: 400 });
  res.clearCookie('accessToken', cookieOptions);
  res.clearCookie('refreshToken', cookieOptions);
  res.json({ data: { message: 'Your account and associated data have been permanently deleted.' } });
};

export const logout = async (req, res) => { await query('UPDATE users SET refresh_token = NULL WHERE id = $1', [req.user._id]); res.clearCookie('accessToken', cookieOptions); res.clearCookie('refreshToken', cookieOptions); res.json({ data: { message: 'Logged out successfully' } }); };
export const refreshToken = async (req, res) => { const incoming = req.cookies?.refreshToken || req.body.refreshToken; if (!incoming) throw Object.assign(new Error('Refresh token is required'), { statusCode: 401 }); const decoded = jwt.verify(incoming, process.env.REFRESH_TOKEN_SECRET); const result = await query('SELECT id AS "_id", username, email, fullnamae, phone, coverimage, default_currency AS "defaultCurrency", username_change_count AS "usernameChangeCount", created_at AS "createdAt" FROM users WHERE id = $1 AND refresh_token = $2', [decoded._id, incoming]); if (!result.rowCount) throw Object.assign(new Error('Invalid refresh token'), { statusCode: 401 }); const data = tokenResponse(result.rows[0]); await query('UPDATE users SET refresh_token = $1 WHERE id = $2', [data.refreshToken, decoded._id]); setCookies(res, data); res.json({ data: { accessToken: data.accessToken, refreshToken: data.refreshToken, tokenType: data.tokenType } }); };
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

export const getEmailNotificationSettings = async (req, res) => {
  const result = await query('SELECT email_notification_preferences AS preferences FROM users WHERE id = $1', [req.user._id]);
  res.json({ data: { preferences: { ...EMAIL_NOTIFICATION_PREFERENCES, ...result.rows[0].preferences } } });
};

export const updateEmailNotificationSettings = async (req, res) => {
  const preferences = req.body?.preferences;
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
    throw Object.assign(new Error('Email notification preferences are required'), { statusCode: 400 });
  }
  const unknown = Object.keys(preferences).filter((key) => !Object.hasOwn(EMAIL_NOTIFICATION_PREFERENCES, key));
  const invalid = Object.keys(EMAIL_NOTIFICATION_PREFERENCES).filter((key) => typeof preferences[key] !== 'boolean');
  if (unknown.length || invalid.length) {
    throw Object.assign(new Error('Provide a true or false setting for every email notification type'), { statusCode: 400 });
  }

  const result = await query(
    'UPDATE users SET email_notification_preferences = $1::jsonb WHERE id = $2 RETURNING email_notification_preferences AS preferences',
    [JSON.stringify(preferences), req.user._id],
  );
  res.json({ data: { preferences: result.rows[0].preferences } });
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
  if (email !== undefined) {
    throw Object.assign(new Error('Email changes require verification codes sent to both email addresses'), { statusCode: 400 });
  }
  const values = {};
  if (username?.trim()) values.username = username.trim().toLowerCase();
  const usernameChanged = values.username && values.username !== req.user.username.toLowerCase();
  if (usernameChanged && Number(req.user.usernameChangeCount || 0) >= 2) {
    throw Object.assign(new Error('You have used both lifetime username changes'), { statusCode: 409 });
  }
  if (fullnamae?.trim()) values.fullnamae = fullnamae.trim();
  if (phone !== undefined) values.phone = phone.trim();
  if (coverimage?.trim()) values.coverimage = coverimage.trim();
  if (defaultCurrency !== undefined) {
    if (typeof defaultCurrency !== 'string' || !(await getAvailableCurrencies()).includes(defaultCurrency)) {
      throw Object.assign(new Error('Choose a currency supported by the exchange-rate provider'), { statusCode: 400 });
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
  const assignments = fields.map((field, index) => `${field} = $${index + 1}`);
  if (usernameChanged) assignments.push('username_change_count = username_change_count + 1');
  const setClause = assignments.join(', ');
  params.push(req.user._id);
  const usernameChangeGuard = usernameChanged ? ' AND username_change_count < 2' : '';
  let result;
  try {
    result = await query(`UPDATE users SET ${setClause} WHERE id = $${params.length}${usernameChangeGuard} RETURNING id AS "_id", username, email, fullnamae, phone, coverimage, default_currency AS "defaultCurrency", username_change_count AS "usernameChangeCount", created_at AS "createdAt"`, params);
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'users_username_key') {
      throw Object.assign(new Error('That username is already taken. Please choose a different one.'), { statusCode: 409 });
    }
    throw error;
  }
  if (!result.rowCount) {
    throw Object.assign(new Error('You have used both lifetime username changes'), { statusCode: 409 });
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
