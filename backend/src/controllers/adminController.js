import { query, withTransaction } from '../db/index.js';
import { queueEmailNotification } from '../services/emailNotificationService.js';
import bcrypt from 'bcrypt';

const defaultSettings = {
  features: { currencyConversion: { free: false, premium: true } },
  limits: { freeDailyExpenses: 5, premiumDailyExpenses: null },
};

const readSettings = (value) => ({
  features: {
    currencyConversion: {
      free: Boolean(value?.features?.currencyConversion?.free),
      premium: value?.features?.currencyConversion?.premium !== false,
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
    `SELECT id AS "_id", username, email, fullnamae, plan, premium_until AS "premiumUntil", created_at AS "createdAt"
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
  const { plan, premiumUntil = null } = req.body || {};
  if (!['free', 'premium'].includes(plan)) throw Object.assign(new Error('Plan must be free or premium'), { statusCode: 400 });
  const result = await query(
    `UPDATE users SET plan = $1, premium_until = CASE WHEN $1 = 'premium' THEN $2::timestamptz ELSE NULL END
      WHERE id = $3 AND role = 'user'
      RETURNING id AS "_id", username, email, plan, premium_until AS "premiumUntil"`,
    [plan, premiumUntil, req.params.userId],
  );
  if (!result.rowCount) throw Object.assign(new Error('User not found'), { statusCode: 404 });
  res.json({ data: result.rows[0] });
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