import { createHmac, timingSafeEqual } from 'node:crypto';
import { query, withTransaction } from '../db/index.js';

const razorpayConfigured = () => {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw Object.assign(new Error('Razorpay is not configured'), { statusCode: 503 });
  }
};

const razorpayRequest = async (path, options = {}) => {
  razorpayConfigured();
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body?.error?.description || 'Razorpay request failed'), { statusCode: 502 });
  return body;
};

const grantPremium = async (client, userId, orderId, paymentId) => {
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

export const createPremiumOrder = async (req, res) => {
  const amount = Number(process.env.PREMIUM_PRICE_INR || 499) * 100;
  if (!Number.isInteger(amount) || amount <= 0) throw Object.assign(new Error('Premium price is not configured correctly'), { statusCode: 503 });
  const order = await razorpayRequest('/orders', {
    method: 'POST',
    body: JSON.stringify({ amount, currency: 'INR', receipt: `premium_${req.user._id}_${Date.now()}`, notes: { userId: req.user._id } }),
  });
  await query(
    `INSERT INTO billing_orders (user_id, provider_order_id, amount, currency) VALUES ($1, $2, $3, 'INR')`,
    [req.user._id, order.id, amount],
  );
  res.status(201).json({ data: { keyId: process.env.RAZORPAY_KEY_ID, orderId: order.id, amount, currency: 'INR' } });
};

const validSignature = (payload, signature, secret) => {
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const actual = Buffer.from(signature || '');
  const expectedBuffer = Buffer.from(expected);
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
};

export const verifyPremiumPayment = async (req, res) => {
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
  if (!orderId || !paymentId || !signature || !validSignature(`${orderId}|${paymentId}`, signature, process.env.RAZORPAY_KEY_SECRET)) {
    throw Object.assign(new Error('Invalid Razorpay payment signature'), { statusCode: 400 });
  }
  const result = await withTransaction(async (client) => {
    const order = await client.query(
      `SELECT user_id AS "userId", status FROM billing_orders WHERE provider_order_id = $1 FOR UPDATE`,
      [orderId],
    );
    if (!order.rowCount) throw Object.assign(new Error('Payment order not found'), { statusCode: 404 });
    if (order.rows[0].status !== 'paid') await grantPremium(client, order.rows[0].userId, orderId, paymentId);
    return order.rows[0].userId;
  });
  res.json({ data: { paid: true, userId: result } });
};

export const razorpayWebhook = async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
  if (!validSignature(rawBody, signature, process.env.RAZORPAY_WEBHOOK_SECRET || '')) {
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }
  const eventId = req.headers['x-razorpay-event-id'] || createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO billing_webhook_events (event_id, event_type, payload) VALUES ($1, $2, $3)
       ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [eventId, req.body?.event || 'unknown', req.body],
    );
    if (!inserted.rowCount || req.body?.event !== 'payment.captured') return;
    const payment = req.body.payload?.payment?.entity;
    if (!payment?.order_id || !payment?.id) return;
    const order = await client.query('SELECT user_id AS "userId" FROM billing_orders WHERE provider_order_id = $1 FOR UPDATE', [payment.order_id]);
    if (order.rowCount) await grantPremium(client, order.rows[0].userId, payment.order_id, payment.id);
  });
  res.json({ received: true });
};