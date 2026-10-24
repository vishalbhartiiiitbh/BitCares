import { query, withTransaction } from '../db/index.js';
import { queueEmailNotification } from '../services/emailNotificationService.js';
import bcrypt from 'bcrypt';

const defaultSettings = {
  features: {
    currencyConversion: { free: false, premium: true },
    dashboardSpendingInsights: { free: false, premium: true },
    groupSpendingInsights: { free: false, premium: true },
  },
  limits: { freeDailyExpenses: 5, premiumDailyExpenses: null },
};

const readSettings = (value) => ({
  features: {
    currencyConversion: {
      free: Boolean(value?.features?.currencyConversion?.free),
      premium: value?.features?.currencyConversion?.premium !== false,
    },
    dashboardSpendingInsights: {
      free: Boolean(value?.features?.dashboardSpendingInsights?.free),
      premium: value?.features?.dashboardSpendingInsights?.premium !== false,
    },
    groupSpendingInsights: {
      free: Boolean(value?.features?.groupSpendingInsights?.free),
      premium: value?.features?.groupSpendingInsights?.premium !== false,
    },
  },
  limits: {
    freeDailyExpenses: Number.isInteger(value?.limits?.freeDailyExpenses) && value.limits.freeDailyExpenses >= 0
      ? value.limits.freeDailyExpenses : defaultSettings.limits.freeDailyExpenses,
    premiumDailyExpenses: value?.limits?.premiumDailyExpenses == null ? null
      : (Number.isInteger(value.limits.premiumDailyExpenses) && value.limits.premiumDailyExpenses >= 0
        ? value.limits.premiumDailyExpenses : defaultSettings.limits.premiumDailyExpenses),
  },
});

export const getAdminDashboard = async (_req, res) => {
  const [settings, counts] = await Promise.all([
    query('SELECT settings, updated_at AS "updatedAt" FROM platform_settings WHERE id = TRUE'),
    query(`SELECT COUNT(*)::integer AS users,
                  COUNT(*) FILTER (WHERE plan = 'premium' AND (premium_until IS NULL OR premium_until > NOW()))::integer AS premium_users
             FROM users WHERE role = 'user'`),
  ]);
  res.json({ data: { settings: readSettings(settings.rows[0]?.settings), updatedAt: settings.rows[0]?.updatedAt, counts: counts.rows[0] } });
};

export const updateAdminSettings = async (req, res) => {
  const settings = readSettings(req.body?.settings);
  const result = await query(
    `UPDATE platform_settings SET settings = $1, updated_by = $2, updated_at = NOW()
      WHERE id = TRUE RETURNING settings, updated_at AS "updatedAt"`,
    [JSON.stringify(settings), req.user._id],
  );
  res.json({ data: { settings: result.rows[0].settings, updatedAt: result.rows[0].updatedAt } });
};

export const listAdminUsers = async (_req, res) => {
  const result = await query(
    `SELECT id AS "_id", username, email, fullnamae,
            CASE WHEN plan = 'premium' AND (premium_until IS NULL OR premium_until > NOW())
              THEN 'premium' ELSE 'free' END AS plan,
            premium_until AS "premiumUntil", created_at AS "createdAt",
            EXISTS (
              SELECT 1
                FROM billing_subscriptions s
               WHERE s.user_id = users.id
                 AND s.status IN ('created', 'authenticated', 'active', 'pending', 'halted', 'paused')
            ) AS "hasOpenRazorpaySubscription",
            (
              SELECT s.status
                FROM billing_subscriptions s
               WHERE s.user_id = users.id
                 AND s.status IN ('created', 'authenticated', 'active', 'pending', 'halted', 'paused')
               ORDER BY s.created_at DESC
               LIMIT 1
            ) AS "razorpaySubscriptionStatus"
       FROM users WHERE role = 'user' ORDER BY created_at DESC`,
  );
  res.json({ data: result.rows });
};

export const listSubAdmins = async (_req, res) => {
  const result = await query(
    `SELECT id AS "_id", username, email, fullnamae, role, created_at AS "createdAt"
       FROM users WHERE role = 'sub_admin' ORDER BY created_at DESC`,
  );
  res.json({ data: result.rows });
};

export const createSubAdmin = async (req, res) => {
  const { username, email, fullnamae, password } = req.body || {};
  if (![username, email, fullnamae, password].every((value) => typeof value === 'string' && value.trim())) {
    throw Object.assign(new Error('Username, email, full name, and password are required'), { statusCode: 400 });
  }
  if (password.length < 8) throw Object.assign(new Error('Password must be at least 8 characters'), { statusCode: 400 });
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    const result = await query(
      `INSERT INTO users (username, email, fullnamae, password, role)
       VALUES ($1, LOWER($2), $3, $4, 'sub_admin')
       RETURNING id AS "_id", username, email, fullnamae, role, created_at AS "createdAt"`,
      [username.trim(), email.trim(), fullnamae.trim(), passwordHash],
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') throw Object.assign(new Error('Username or email already exists'), { statusCode: 409 });
    throw error;
  }
};

export const deleteSubAdmin = async (req, res) => {
  const result = await query(
    `DELETE FROM users WHERE id = $1 AND role = 'sub_admin' RETURNING id`,
    [req.params.userId],
  );
  if (!result.rowCount) throw Object.assign(new Error('Sub-admin not found'), { statusCode: 404 });
  res.json({ data: { deleted: true } });
};

export const updateUserPlan = async (req, res) => {
  const { plan, premiumDuration } = req.body || {};
  if (plan !== 'premium') {
    throw Object.assign(new Error('This action only grants Premium access; it cannot deactivate or revoke access.'), { statusCode: 400 });
  }
  const duration = {
      weekly: { months: 0, days: 7 },
      monthly: { months: 1, days: 0 },
      six_month: { months: 6, days: 0 },
      yearly: { months: 12, days: 0 },
    }[premiumDuration];
  if (!duration) {
    throw Object.assign(new Error('Choose a valid Premium duration'), { statusCode: 400 });
  }

  const updatedUser = await withTransaction(async (client) => {
    const userResult = await client.query(
      `SELECT premium_until AS "premiumUntil",
              (plan = 'premium' AND (premium_until IS NULL OR premium_until > NOW())) AS "hasPremiumAccess",
              EXISTS (
                SELECT 1
                  FROM billing_subscriptions s
                 WHERE s.user_id = users.id
                   AND s.status IN ('created', 'authenticated', 'active', 'pending', 'halted', 'paused')
              ) AS "hasOpenRazorpaySubscription"
         FROM users WHERE id = $1 AND role = 'user' FOR UPDATE`,
      [req.params.userId],
    );
    if (!userResult.rowCount) throw Object.assign(new Error('User not found'), { statusCode: 404 });
    if (userResult.rows[0].hasPremiumAccess) {
      throw Object.assign(new Error('This user already has active Premium access.'), { statusCode: 409 });
    }
    if (userResult.rows[0].hasOpenRazorpaySubscription) {
      throw Object.assign(new Error('This user has a Razorpay subscription in progress. Manual Premium grants are only available when there is no open Razorpay subscription.'), { statusCode: 409 });
    }
    const currentExpiry = userResult.rows[0].premiumUntil;
    const expiry = currentExpiry && new Date(currentExpiry) > new Date()
      ? new Date(currentExpiry)
      : new Date();
    const originalDay = expiry.getUTCDate();
    if (duration.months) {
      expiry.setUTCDate(1);
      expiry.setUTCMonth(expiry.getUTCMonth() + duration.months);
      const lastDay = new Date(Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth() + 1, 0)).getUTCDate();
      expiry.setUTCDate(Math.min(originalDay, lastDay));
    }
    if (duration.days) expiry.setUTCDate(expiry.getUTCDate() + duration.days);
    const premiumUntil = expiry.toISOString();
    const result = await client.query(
      `UPDATE users SET plan = 'premium', premium_until = $1::timestamptz
        WHERE id = $2 AND role = 'user'
        RETURNING id AS "_id", username, email, plan, premium_until AS "premiumUntil"`,
      [premiumUntil, req.params.userId],
    );
    if (!result.rowCount) throw Object.assign(new Error('User not found'), { statusCode: 404 });
    return result.rows[0];
  });
  res.json({ data: updatedUser });
};

export const broadcastProductUpdate = async (req, res) => {
  const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!subject || !message) throw Object.assign(new Error('Subject and message are required'), { statusCode: 400 });
  const result = await withTransaction(async (client) => {
    const users = await client.query('SELECT id, email FROM users WHERE role = \'user\'');
    for (const user of users.rows) {
      await client.query(
        `INSERT INTO notifications (user_id, message, created_by, notification_type)
         VALUES ($1, $2, $3, 'PRODUCT_UPDATE')`,
        [user.id, message, req.user._id],
      );
      await queueEmailNotification(client, user.id, 'productUpdates', subject, message);
    }
    return users.rowCount;
  });
  res.status(201).json({ data: { recipients: result } });
};