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

/** Validate persisted platform settings and fill any missing options with safe defaults. */
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

/** Return platform settings and account counts for the admin dashboard. */
export const getAdminDashboard = async (_req, res) => {
  const [settings, counts] = await Promise.all([
    query('SELECT settings, updated_at AS "updatedAt" FROM platform_settings WHERE id = TRUE'),
    query(`SELECT COUNT(*)::integer AS users,
                  COUNT(*) FILTER (WHERE plan = 'premium' AND (premium_until IS NULL OR premium_until > NOW()))::integer AS premium_users
             FROM users WHERE role = 'user'`),
  ]);
  res.json({ data: { settings: readSettings(settings.rows[0]?.settings), updatedAt: settings.rows[0]?.updatedAt, counts: counts.rows[0] } });
};

/** Validate and persist the platform-wide feature and usage-limit settings. */
export const updateAdminSettings = async (req, res) => {
  const settings = readSettings(req.body?.settings);
  const result = await query(
    `UPDATE platform_settings SET settings = $1, updated_by = $2, updated_at = NOW()
      WHERE id = TRUE RETURNING settings, updated_at AS "updatedAt"`,
    [JSON.stringify(settings), req.user._id],
  );
  res.json({ data: { settings: result.rows[0].settings, updatedAt: result.rows[0].updatedAt } });
};

/** List ordinary accounts with their Premium and pending-subscription eligibility. */
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

/** List coupons with successful and in-progress redemption counts. */
export const listBillingCoupons = async (_req, res) => {
  const result = await query(
    `SELECT c.id, c.code, c.discount_type AS "discountType",
            c.discount_value AS "discountValue", c.application,
            c.razorpay_offer_id AS "razorpayOfferId",
            c.max_redemptions AS "maxRedemptions", c.active,
            c.created_at AS "createdAt",
            COUNT(r.id) FILTER (WHERE r.status = 'redeemed')::integer AS "usedCount",
            COUNT(r.id) FILTER (WHERE r.status = 'reserved')::integer AS "pendingCount"
       FROM billing_coupons c
       LEFT JOIN billing_coupon_redemptions r ON r.coupon_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC`,
  );
  res.json({ data: result.rows });
};

/** Validate and create an admin coupon, including its limit and Razorpay Offer mapping. */
export const createBillingCoupon = async (req, res) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
  const discountType = req.body?.discountType;
  const discountValue = Number(req.body?.discountValue);
  const application = req.body?.application;
  const razorpayOfferId = typeof req.body?.razorpayOfferId === 'string'
    ? req.body.razorpayOfferId.trim()
    : '';
  const maxRedemptions = Number(req.body?.maxRedemptions);

  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) {
    throw Object.assign(new Error('Coupon code must be 3-40 letters, numbers, hyphens, or underscores'), { statusCode: 400 });
  }
  if (!['percentage', 'fixed_inr'].includes(discountType)) {
    throw Object.assign(new Error('Choose a percentage or fixed INR discount'), { statusCode: 400 });
  }
  if (!Number.isFinite(discountValue) || discountValue <= 0
    || (discountType === 'percentage' && discountValue > 100)
    || Math.abs(discountValue * 100 - Math.round(discountValue * 100)) > 1e-8) {
    throw Object.assign(new Error('Enter a valid discount amount; percentage discounts may be up to 100% and INR values may use up to 2 decimals'), { statusCode: 400 });
  }
  if (!['single_use', 'forever'].includes(application)) {
    throw Object.assign(new Error('Choose whether the discount applies to the first payment or every renewal'), { statusCode: 400 });
  }
  const isFreeGrant = discountType === 'percentage' && discountValue === 100;
  if (isFreeGrant && application !== 'single_use') {
    throw Object.assign(new Error('A 100% coupon grants one selected billing period for free and cannot apply to every renewal'), { statusCode: 400 });
  }
  if (!isFreeGrant && !/^offer_[A-Za-z0-9]+$/.test(razorpayOfferId)) {
    throw Object.assign(new Error('Enter a valid Razorpay Subscription Offer ID'), { statusCode: 400 });
  }
  if (!Number.isSafeInteger(maxRedemptions) || maxRedemptions < 1) {
    throw Object.assign(new Error('Set a redemption limit of at least 1'), { statusCode: 400 });
  }

  try {
    const result = await query(
      `INSERT INTO billing_coupons (
         code, discount_type, discount_value, application,
         razorpay_offer_id, max_redemptions, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, code, discount_type AS "discountType",
                 discount_value AS "discountValue", application,
                 razorpay_offer_id AS "razorpayOfferId",
                 max_redemptions AS "maxRedemptions", active,
                 created_at AS "createdAt"`,
      [code, discountType, discountValue, application, isFreeGrant ? null : razorpayOfferId, maxRedemptions, req.user._id],
    );
    res.status(201).json({ data: { ...result.rows[0], usedCount: 0, pendingCount: 0 } });
  } catch (error) {
    if (error.code === '23505') {
      throw Object.assign(new Error('That coupon code already exists'), { statusCode: 409 });
    }
    throw error;
  }
};

/** Enable or disable an existing coupon without deleting its redemption history. */
export const updateBillingCoupon = async (req, res) => {
  if (typeof req.body?.active !== 'boolean') {
    throw Object.assign(new Error('Coupon active status must be true or false'), { statusCode: 400 });
  }
  const result = await query(
    `UPDATE billing_coupons SET active = $2
      WHERE id = $1
      RETURNING id, code, active`,
    [req.params.couponId, req.body.active],
  );
  if (!result.rowCount) throw Object.assign(new Error('Coupon not found'), { statusCode: 404 });
  res.json({ data: result.rows[0] });
};

/** Return sub-admin accounts for the primary admin's access-management view. */
export const listSubAdmins = async (_req, res) => {
  const result = await query(
    `SELECT id AS "_id", username, email, fullnamae, role, created_at AS "createdAt"
       FROM users WHERE role = 'sub_admin' ORDER BY created_at DESC`,
  );
  res.json({ data: result.rows });
};

/** Create a sub-admin account after validating its identity and initial password. */
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

/** Remove a sub-admin account; related account-owned records follow database rules. */
export const deleteSubAdmin = async (req, res) => {
  const result = await query(
    `DELETE FROM users WHERE id = $1 AND role = 'sub_admin' RETURNING id`,
    [req.params.userId],
  );
  if (!result.rowCount) throw Object.assign(new Error('Sub-admin not found'), { statusCode: 404 });
  res.json({ data: { deleted: true } });
};

/** Grant a selected user a fixed Premium period when no active entitlement or subscription exists. */
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

/** Publish a product update to every user and queue email for opted-in recipients. */
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