import { createHmac, timingSafeEqual } from 'node:crypto';
import Razorpay from 'razorpay';
import { query, withTransaction } from '../db/index.js';

const premiumPlans = {
  weekly: { razorpayPeriod: 'weekly', interval: 1, amount: 1000, currency: 'INR', label: 'Weekly' },
  six_month: { razorpayPeriod: 'monthly', interval: 6, amount: 27500, currency: 'INR', label: 'Every 6 months' },
  monthly: { razorpayPeriod: 'monthly', interval: 1, amount: 5000, currency: 'INR', label: 'Monthly' },
  yearly: { razorpayPeriod: 'yearly', interval: 1, amount: 50000, currency: 'INR', label: 'Yearly' },
};
const billingPeriods = Object.keys(premiumPlans);
const planCache = new Map();
const planCacheTtlMs = 10 * 60 * 1000;
const supportedEvents = new Set([
  'subscription.authenticated',
  'subscription.activated',
  'subscription.charged',
  'subscription.pending',
  'subscription.halted',
  'subscription.cancelled',
  'subscription.completed',
  'subscription.paused',
  'subscription.resumed',
  'subscription.updated',
  'payment.captured',
  'payment.failed',
]);

const razorpayClient = () => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw Object.assign(new Error('Razorpay is not configured'), { statusCode: 503 });
  }
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
};

const validSignature = (payload, signature, secret) => {
  if (!secret || typeof signature !== 'string' || !/^[a-f\d]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const toEpoch = (value) => {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
};

const addBillingInterval = (date, period, interval) => {
  const result = new Date(date);
  if (period === 'weekly') {
    result.setUTCDate(result.getUTCDate() + 7 * interval);
    return result;
  }

  const months = period === 'yearly' ? 12 * interval : interval;
  const dayOfMonth = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDayOfTargetMonth = new Date(Date.UTC(
    result.getUTCFullYear(),
    result.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  result.setUTCDate(Math.min(dayOfMonth, lastDayOfTargetMonth));
  return result;
};

const paidThroughDate = (subscription, payment) => {
  if (subscription.currentEnd) return subscription.currentEnd;
  const period = subscription.billingPeriod;
  const interval = Number(subscription.billingInterval);
  if (!premiumPlans[period] || !Number.isInteger(interval) || interval < 1) return null;
  const start = subscription.currentStart
    || toEpoch(payment?.created_at)
    || Math.floor(Date.now() / 1000);
  return addBillingInterval(new Date(start * 1000), period === 'six_month' ? 'monthly' : period, interval);
};

const planIdFor = (period) => process.env[`RAZORPAY_PLAN_ID_${period.toUpperCase()}`]?.trim();

const unavailablePlan = (period, planId, reason) => ({
  period,
  ...premiumPlans[period],
  id: planId || null,
  configured: false,
  configurationError: reason,
});

const fetchPlan = async (period) => {
  const expected = premiumPlans[period];
  const planId = planIdFor(period);
  if (!planId) return { period, ...expected, id: null, configured: false };
  const cachedPlan = planCache.get(planId);
  if (cachedPlan && cachedPlan.expiresAt > Date.now()) return cachedPlan.value;
  let plan;
  try {
    plan = await razorpayClient().plans.fetch(planId);
  } catch (error) {
    console.error('Razorpay plan lookup failed', {
      period,
      statusCode: error.statusCode || error.status,
      errorCode: error.error?.code || error.code,
    });
    if (cachedPlan) return cachedPlan.value;
    return unavailablePlan(period, planId, error.statusCode === 429
      ? 'Razorpay is temporarily rate-limiting plan checks. Please refresh Billing in a few minutes.'
      : 'Could not validate this Razorpay Plan. Check that the Plan ID and API keys belong to the same Razorpay mode.');
  }
  const amount = Number(plan.item?.amount);
  const currency = plan.item?.currency;
  if (
    plan.id !== planId ||
    plan.period !== expected.razorpayPeriod ||
    plan.interval !== expected.interval ||
    amount !== expected.amount ||
    currency !== expected.currency
  ) {
    return unavailablePlan(
      period,
      planId,
      `Razorpay Plan must be INR ${expected.amount / 100} with a ${expected.label.toLowerCase()} billing interval.`,
    );
  }
  const value = { id: plan.id, period, interval: plan.interval, amount, currency, label: expected.label, configured: true };
  planCache.set(planId, { value, expiresAt: Date.now() + planCacheTtlMs });
  return value;
};

const safeSubscription = (subscription) => ({
  providerSubscriptionId: subscription.id,
  status: subscription.status || 'created',
  currentStart: toEpoch(subscription.current_start),
  currentEnd: toEpoch(subscription.current_end),
  nextBillingAt: toEpoch(subscription.charge_at),
  startedAt: toEpoch(subscription.start_at),
  endedAt: toEpoch(subscription.end_at || subscription.ended_at),
  cancelledAt: toEpoch(subscription.cancelled_at),
  pausedAt: toEpoch(subscription.paused_at || subscription.pause_initiated_at || subscription.pause_at),
  cancelAtCycleEnd: subscription.cancel_at_cycle_end === undefined
    ? null
    : Boolean(subscription.cancel_at_cycle_end),
});

const saveSubscriptionSnapshot = async (client, subscription) => {
  if (!subscription?.id) return null;
  const snapshot = safeSubscription(subscription);
  const { rows } = await client.query(
    `UPDATE billing_subscriptions
        SET status = $2,
            current_start = COALESCE(to_timestamp($3), current_start),
            current_end = COALESCE(to_timestamp($4), current_end),
            next_billing_at = COALESCE(to_timestamp($5), next_billing_at),
            started_at = COALESCE(to_timestamp($6), started_at),
            ended_at = COALESCE(to_timestamp($7), ended_at),
            cancelled_at = COALESCE(to_timestamp($8), cancelled_at),
            paused_at = COALESCE(to_timestamp($9), paused_at),
            cancel_at_cycle_end = COALESCE($10, cancel_at_cycle_end),
            updated_at = NOW()
      WHERE provider_subscription_id = $1
      RETURNING user_id AS "userId", current_end AS "currentEnd",
                current_start AS "currentStart", billing_period AS "billingPeriod",
                billing_interval AS "billingInterval"`,
    [
      snapshot.providerSubscriptionId,
      snapshot.status,
      snapshot.currentStart,
      snapshot.currentEnd,
      snapshot.nextBillingAt,
      snapshot.startedAt,
      snapshot.endedAt,
      snapshot.cancelledAt,
      snapshot.pausedAt,
      snapshot.cancelAtCycleEnd,
    ],
  );
  return rows[0] || null;
};

const savePayment = async (client, payment, userId, status) => {
  if (!payment?.id || !userId) return false;
  const amount = Number(payment.amount);
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error('Razorpay payment amount is invalid');
  }
  const paidAt = toEpoch(payment.created_at);
  const { rowCount } = await client.query(
    `INSERT INTO billing_payments (
       user_id, provider_payment_id, provider_order_id, provider_subscription_id,
       amount, currency, status, paid_at, failure_code, failure_description
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8), $9, $10)
     ON CONFLICT (provider_payment_id) DO UPDATE
       SET status = CASE
             WHEN billing_payments.status = 'captured' THEN 'captured'
             ELSE EXCLUDED.status
           END,
           paid_at = COALESCE(billing_payments.paid_at, EXCLUDED.paid_at),
           failure_code = CASE WHEN billing_payments.status = 'captured' THEN NULL ELSE EXCLUDED.failure_code END,
           failure_description = CASE WHEN billing_payments.status = 'captured' THEN NULL ELSE EXCLUDED.failure_description END,
           updated_at = NOW()`,
    [
      userId,
      payment.id,
      payment.order_id || null,
      payment.subscription_id || null,
      amount,
      payment.currency || 'INR',
      status,
      paidAt,
      status === 'failed' ? payment.error_code || null : null,
      status === 'failed' ? payment.error_description || payment.error_reason || null : null,
    ],
  );
  return rowCount > 0;
};

const applySubscriptionPayment = async (client, payment, subscriptionRow) => {
  if (!payment || !subscriptionRow) return;
  await savePayment(client, payment, subscriptionRow.userId, 'captured');
  const premiumUntil = paidThroughDate(subscriptionRow, payment);
  if (!premiumUntil) return;
  await client.query(
    `UPDATE users
        SET premium_until = GREATEST(COALESCE(premium_until, NOW()), $2),
            plan = CASE WHEN $2 > NOW() THEN 'premium' ELSE plan END
      WHERE id = $1`,
    [subscriptionRow.userId, premiumUntil],
  );
};

const createLegacyPremiumGrant = async (client, userId, orderId, paymentId) => {
  await client.query(
    `UPDATE billing_orders SET status = 'paid', provider_payment_id = $1, paid_at = NOW()
      WHERE provider_order_id = $2 AND user_id = $3`,
    [paymentId, orderId, userId],
  );
  await client.query(
    `UPDATE users SET plan = 'premium', premium_until = GREATEST(COALESCE(premium_until, NOW()), NOW()) + INTERVAL '30 days'
      WHERE id = $1`,
    [userId],
  );
};

export const listSubscriptionPlans = async (_req, res) => {
  const plans = [];
  for (const period of billingPeriods) {
    const plan = await fetchPlan(period);
    plans.push({
      period: plan.period,
      interval: plan.interval,
      amount: plan.amount,
      currency: plan.currency,
      label: plan.label,
      configured: plan.configured,
      configurationError: plan.configurationError || null,
    });
  }
  res.json({ data: { plans } });
};

export const createPremiumOrder = async (req, res) => {
  const amount = Number(process.env.PREMIUM_PRICE_INR || 499) * 100;
  if (!Number.isInteger(amount) || amount < 100) {
    throw Object.assign(new Error('Premium price is not configured correctly'), { statusCode: 503 });
  }
  const order = await razorpayClient().orders.create({
    amount,
    currency: 'INR',
    receipt: `premium_${req.user._id}_${Date.now()}`,
    notes: { userId: req.user._id },
  });
  await query(
    `INSERT INTO billing_orders (user_id, provider_order_id, amount, currency) VALUES ($1, $2, $3, 'INR')`,
    [req.user._id, order.id, amount],
  );
  res.status(201).json({ data: { keyId: process.env.RAZORPAY_KEY_ID, orderId: order.id, amount, currency: 'INR' } });
};

export const createPremiumSubscription = async (req, res) => {
  const period = req.body?.period;
  if (!billingPeriods.includes(period)) {
    throw Object.assign(new Error('Choose a configured billing interval'), { statusCode: 400 });
  }
  const plan = await fetchPlan(period);
  if (!plan.configured) {
    throw Object.assign(
      new Error(plan.configurationError || `No Razorpay plan is configured for ${period} billing`),
      { statusCode: 503 },
    );
  }
  const totalCount = period === 'weekly' ? 520 : period === 'yearly' ? 10 : period === 'six_month' ? 20 : 120;
  const subscription = await withTransaction(async (client) => {
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user._id]);
    const openSubscriptions = await client.query(
      `SELECT provider_subscription_id FROM billing_subscriptions
        WHERE user_id = $1 AND status IN ('created', 'authenticated', 'active', 'pending', 'halted', 'paused')
        LIMIT 1`,
      [req.user._id],
    );
    if (openSubscriptions.rowCount) {
      throw Object.assign(new Error('You already have a subscription in progress. Manage it from Billing.'), { statusCode: 409 });
    }
    const created = await razorpayClient().subscriptions.create({
      plan_id: plan.id,
      total_count: totalCount,
      quantity: 1,
      customer_notify: true,
      notes: { userId: req.user._id, billingPeriod: period },
    });
    const snapshot = safeSubscription(created);
    await client.query(
      `INSERT INTO billing_subscriptions (
         user_id, provider_subscription_id, provider_plan_id, billing_period,
         billing_interval, plan_amount, currency, status, current_start, current_end, next_billing_at,
         started_at, ended_at, cancelled_at, paused_at, cancel_at_cycle_end
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9), to_timestamp($10),
         to_timestamp($11), to_timestamp($12), to_timestamp($13), to_timestamp($14),
         to_timestamp($15), $16
       )`,
      [
        req.user._id,
        created.id,
        plan.id,
        plan.period,
        plan.interval,
        plan.amount,
        plan.currency,
        snapshot.status,
        snapshot.currentStart,
        snapshot.currentEnd,
        snapshot.nextBillingAt,
        snapshot.startedAt,
        snapshot.endedAt,
        snapshot.cancelledAt,
        snapshot.pausedAt,
        snapshot.cancelAtCycleEnd ?? false,
      ],
    );
    return created;
  });
  res.status(201).json({
    data: {
      keyId: process.env.RAZORPAY_KEY_ID,
      subscriptionId: subscription.id,
      plan: {
        period: plan.period,
        interval: plan.interval,
        amount: plan.amount,
        currency: plan.currency,
        label: plan.label,
      },
    },
  });
};

export const verifyPremiumSubscription = async (req, res) => {
  const {
    razorpay_subscription_id: subscriptionId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signature,
  } = req.body || {};
  if (
    typeof subscriptionId !== 'string' || !subscriptionId ||
    typeof paymentId !== 'string' || !paymentId ||
    typeof signature !== 'string' || !signature
  ) {
    throw Object.assign(new Error('Missing Razorpay subscription payment fields'), { statusCode: 400 });
  }
  const { rows } = await query(
    `SELECT provider_subscription_id AS "providerSubscriptionId", status
       FROM billing_subscriptions
      WHERE provider_subscription_id = $1 AND user_id = $2`,
    [subscriptionId, req.user._id],
  );
  if (!rows.length) {
    throw Object.assign(new Error('Subscription not found'), { statusCode: 404 });
  }
  if (!validSignature(`${paymentId}|${rows[0].providerSubscriptionId}`, signature, process.env.RAZORPAY_KEY_SECRET)) {
    throw Object.assign(new Error('Invalid Razorpay subscription signature'), { statusCode: 400 });
  }
  await query(
    `UPDATE billing_subscriptions SET status = 'authenticated', updated_at = NOW()
      WHERE provider_subscription_id = $1 AND user_id = $2
        AND status IN ('created', 'authenticated')`,
    [subscriptionId, req.user._id],
  );
  res.json({ data: { verified: true, message: 'Subscription authorization received; premium access updates after payment confirmation.' } });
};

export const getBillingSummary = async (req, res) => {
  const [subscriptionResult, paymentResult] = await Promise.all([
    query(
      `SELECT provider_subscription_id AS "subscriptionId", provider_plan_id AS "planId",
              billing_period AS "billingPeriod", billing_interval AS "billingInterval",
              plan_amount AS "planAmount", currency, status,
              current_start AS "currentStart", current_end AS "currentEnd",
              next_billing_at AS "nextBillingAt", started_at AS "startedAt",
              ended_at AS "endedAt", cancelled_at AS "cancelledAt",
              paused_at AS "pausedAt", cancel_at_cycle_end AS "cancelAtCycleEnd",
              created_at AS "createdAt"
         FROM billing_subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [req.user._id],
    ),
    query(
      `SELECT provider_payment_id AS "paymentId", provider_order_id AS "orderId",
              provider_subscription_id AS "subscriptionId", amount, currency, status,
              paid_at AS "paidAt", failure_code AS "failureCode",
              failure_description AS "failureDescription", created_at AS "createdAt"
         FROM billing_payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user._id],
    ),
  ]);
  res.json({
    data: {
      plan: req.user.plan,
      premiumUntil: req.user.premiumUntil,
      keyId: process.env.RAZORPAY_KEY_ID || null,
      subscription: subscriptionResult.rows[0] || null,
      payments: paymentResult.rows,
    },
  });
};

export const cancelPremiumSubscription = async (req, res) => {
  const { subscriptionId } = req.params;
  const { rows } = await query(
    `SELECT provider_subscription_id AS "subscriptionId"
       FROM billing_subscriptions WHERE provider_subscription_id = $1 AND user_id = $2`,
    [subscriptionId, req.user._id],
  );
  if (!rows.length) {
    throw Object.assign(new Error('Subscription not found'), { statusCode: 404 });
  }
  const subscription = await razorpayClient().subscriptions.cancel(rows[0].subscriptionId, true);
  const result = await withTransaction(async (client) => {
    await saveSubscriptionSnapshot(client, subscription);
    if (!['cancelled', 'completed', 'expired'].includes(subscription.status)) {
      await client.query(
        `UPDATE billing_subscriptions
            SET cancel_at_cycle_end = TRUE, updated_at = NOW()
          WHERE provider_subscription_id = $1 AND user_id = $2`,
        [subscriptionId, req.user._id],
      );
    }
    const { rows: updated } = await client.query(
      `SELECT status, current_end AS "currentEnd", cancel_at_cycle_end AS "cancelAtCycleEnd"
         FROM billing_subscriptions WHERE provider_subscription_id = $1 AND user_id = $2`,
      [subscriptionId, req.user._id],
    );
    return updated[0];
  });
  res.json({ data: result });
};

export const changePremiumSubscription = async (req, res) => {
  const { subscriptionId } = req.params;
  const current = await query(
    `SELECT s.status, s.cancel_at_cycle_end AS "cancelAtCycleEnd",
            EXISTS (
              SELECT 1 FROM billing_payments p
               WHERE p.provider_subscription_id = s.provider_subscription_id
                 AND p.status = 'captured'
            ) AS "hasSuccessfulPayment"
       FROM billing_subscriptions s
      WHERE s.provider_subscription_id = $1 AND s.user_id = $2`,
    [subscriptionId, req.user._id],
  );
  if (!current.rowCount) {
    throw Object.assign(new Error('Subscription not found'), { statusCode: 404 });
  }
  const subscriptionRow = current.rows[0];
  const provider = razorpayClient();
  let subscription;
  try {
    subscription = await provider.subscriptions.fetch(subscriptionId);
  } catch (error) {
    if (error.statusCode === 429) {
      throw Object.assign(new Error('Razorpay is temporarily rate-limiting requests. Please wait a few minutes and try again.'), { statusCode: 503 });
    }
    throw error;
  }
  if (['cancelled', 'completed', 'expired'].includes(subscription.status)) {
    await withTransaction((client) => saveSubscriptionSnapshot(client, subscription));
    return res.json({ data: { changed: true, effective: 'immediate', status: subscription.status } });
  }
  if (subscriptionRow.cancelAtCycleEnd) {
    return res.json({ data: { changed: false, effective: 'period_end', status: subscriptionRow.status } });
  }

  const immediate = ['created', 'authenticated'].includes(subscriptionRow.status)
    && !subscriptionRow.hasSuccessfulPayment;
  try {
    subscription = await provider.subscriptions.cancel(subscriptionId, !immediate);
  } catch (error) {
    if (error.statusCode === 429) {
      throw Object.assign(new Error('Razorpay is temporarily rate-limiting requests. Please wait a few minutes and try again.'), { statusCode: 503 });
    }
    throw error;
  }
  const result = await withTransaction(async (client) => {
    await saveSubscriptionSnapshot(client, subscription);
    if (!immediate && !['cancelled', 'completed', 'expired'].includes(subscription.status)) {
      await client.query(
        `UPDATE billing_subscriptions
            SET cancel_at_cycle_end = TRUE, updated_at = NOW()
          WHERE provider_subscription_id = $1 AND user_id = $2`,
        [subscriptionId, req.user._id],
      );
    }
    const { rows } = await client.query(
      `SELECT status, cancel_at_cycle_end AS "cancelAtCycleEnd"
         FROM billing_subscriptions WHERE provider_subscription_id = $1 AND user_id = $2`,
      [subscriptionId, req.user._id],
    );
    return rows[0];
  });
  res.json({
    data: {
      changed: true,
      effective: immediate ? 'immediate' : 'period_end',
      ...result,
    },
  });
};

const applyWebhookEvent = async (client, eventType, payload) => {
  const subscription = payload.subscription?.entity;
  const payment = payload.payment?.entity;
  const subscriptionId = subscription?.id || payment?.subscription_id;
  let subscriptionRow = await saveSubscriptionSnapshot(client, subscription);

  if (!subscriptionRow && subscriptionId) {
    const { rows } = await client.query(
      `SELECT user_id AS "userId", current_end AS "currentEnd",
              current_start AS "currentStart", billing_period AS "billingPeriod",
              billing_interval AS "billingInterval"
         FROM billing_subscriptions WHERE provider_subscription_id = $1 FOR UPDATE`,
      [subscriptionId],
    );
    subscriptionRow = rows[0] || null;
  }

  if (payment?.id) {
    const paymentStatus = eventType === 'payment.failed' ? 'failed' : 'captured';
    let userId = subscriptionRow?.userId;
    if (!userId && payment.order_id) {
      const { rows } = await client.query(
        `SELECT user_id AS "userId" FROM billing_orders WHERE provider_order_id = $1 FOR UPDATE`,
        [payment.order_id],
      );
      userId = rows[0]?.userId;
    }
    if (userId) await savePayment(client, payment, userId, paymentStatus);

    if (paymentStatus === 'captured' && subscriptionRow) {
      await applySubscriptionPayment(client, payment, subscriptionRow);
    } else if (paymentStatus === 'captured' && payment.order_id && userId) {
      const { rows } = await client.query(
        `SELECT status FROM billing_orders WHERE provider_order_id = $1 AND user_id = $2 FOR UPDATE`,
        [payment.order_id, userId],
      );
      if (rows[0]?.status !== 'paid') {
        await createLegacyPremiumGrant(client, userId, payment.order_id, payment.id);
      }
    }
  }

  if (eventType === 'subscription.charged' && subscriptionRow) {
    const premiumUntil = paidThroughDate(subscriptionRow, payment);
    if (!premiumUntil) return;
    await client.query(
      `UPDATE users
          SET premium_until = GREATEST(COALESCE(premium_until, NOW()), $2),
              plan = CASE WHEN $2 > NOW() THEN 'premium' ELSE plan END
        WHERE id = $1`,
      [subscriptionRow.userId, premiumUntil],
    );
  }
};

export const razorpayWebhook = async (req, res) => {
  const rawBody = req.rawBody;
  const signature = req.headers['x-razorpay-signature'];
  if (!Buffer.isBuffer(rawBody) || !validSignature(rawBody, signature, process.env.RAZORPAY_WEBHOOK_SECRET)) {
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }
  if (!supportedEvents.has(event.event)) {
    return res.status(400).json({ error: 'Unsupported Razorpay event' });
  }

  const eventId = req.headers['x-razorpay-event-id']
    || createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  let duplicate = false;
  try {
    await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO billing_webhook_events (
           event_id, event_type, payload, processing_status, received_at, attempts
         ) VALUES ($1, $2, '{}'::jsonb, 'processing', NOW(), 1)
         ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [eventId, event.event],
      );
      if (!inserted.rowCount) {
        const { rows } = await client.query(
          `SELECT processing_status AS status
             FROM billing_webhook_events WHERE event_id = $1 FOR UPDATE`,
          [eventId],
        );
        if (rows[0]?.status === 'processed') {
          duplicate = true;
          return;
        }
        await client.query(
          `UPDATE billing_webhook_events
              SET event_type = $2, processing_status = 'processing',
                  safe_error = NULL, attempts = attempts + 1
            WHERE event_id = $1`,
          [eventId, event.event],
        );
      }
      await applyWebhookEvent(client, event.event, event.payload || {});
      await client.query(
        `UPDATE billing_webhook_events
            SET processing_status = 'processed', processed_at = NOW(), safe_error = NULL
          WHERE event_id = $1`,
        [eventId],
      );
    });
  } catch (error) {
    await query(
      `INSERT INTO billing_webhook_events (
         event_id, event_type, payload, processing_status, received_at, safe_error
       ) VALUES ($1, $2, '{}'::jsonb, 'failed', NOW(), $3)
       ON CONFLICT (event_id) DO UPDATE
         SET processing_status = 'failed', safe_error = EXCLUDED.safe_error,
             attempts = billing_webhook_events.attempts + 1`,
      [eventId, event.event, error.code || error.name || 'processing_error'],
    );
    console.error('Razorpay webhook processing failed', {
      eventId,
      eventType: event.event,
      errorName: error.name,
      errorCode: error.code,
    });
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
  res.json({ received: true, duplicate });
};

export const verifyPremiumPayment = async (req, res) => {
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
  if (
    typeof orderId !== 'string' || !orderId ||
    typeof paymentId !== 'string' || !paymentId ||
    typeof signature !== 'string' || !signature
  ) {
    throw Object.assign(new Error('Missing Razorpay payment fields'), { statusCode: 400 });
  }
  if (!validSignature(`${orderId}|${paymentId}`, signature, process.env.RAZORPAY_KEY_SECRET)) {
    throw Object.assign(new Error('Invalid Razorpay payment signature'), { statusCode: 400 });
  }
  const result = await withTransaction(async (client) => {
    const order = await client.query(
      `SELECT user_id AS "userId", status, amount, currency
         FROM billing_orders WHERE provider_order_id = $1 FOR UPDATE`,
      [orderId],
    );
    if (!order.rowCount || order.rows[0].userId !== req.user._id) {
      throw Object.assign(new Error('Payment order not found'), { statusCode: 404 });
    }
    if (order.rows[0].status !== 'paid') {
      await savePayment(
        client,
        { id: paymentId, order_id: orderId, amount: order.rows[0].amount, currency: order.rows[0].currency },
        req.user._id,
        'captured',
      );
      await createLegacyPremiumGrant(client, req.user._id, orderId, paymentId);
    }
    return req.user._id;
  });
  res.json({ data: { paid: true, userId: result } });
};
