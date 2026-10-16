import { query, withTransaction } from '../db/index.js';
import {
  createFriendExpense as addFriendExpense,
  getFriendHistory,
  settleFriendBalances,
} from '../services/friendLedgerService.js';
import { deleteExpense, updateExpense } from '../services/expenseService.js';
import { validateExpenseOptions } from './expenseController.js';

const parseArray = (value, label) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') throw Object.assign(new Error(`${label} must be a list`), { statusCode: 400 });
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Use the same client-facing validation error for malformed JSON and non-list JSON.
  }
  throw Object.assign(new Error(`${label} must be a valid list`), { statusCode: 400 });
};

const friendKey = (firstId, secondId) => [firstId, secondId].sort();

export const listFriends = async (req, res) => {
  const result = await query(
    `SELECT u.id AS "_id", u.username, u.fullnamae, u.email, u.coverimage, f.created_at AS "addedAt"
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.user_low = $1 THEN f.user_high ELSE f.user_low END
     WHERE f.user_low = $1 OR f.user_high = $1`,
    [req.user._id],
  );
  res.json({ data: result.rows });
};

export const friendHistory = async (req, res) => {
  res.json({ data: await getFriendHistory(req.user._id, req.params.friendId) });
};

export const createFriendExpense = async (req, res) => {
  validateExpenseOptions(req.body);
  const expense = await addFriendExpense({
    userId: req.user._id,
    friendId: req.params.friendId,
    expense: {
      ...req.body,
      actorId: req.user._id,
      participants: parseArray(req.body.participants, 'Participants'),
      values: req.body.values ? parseArray(req.body.values, 'Split values') : undefined,
      items: req.body.items ? parseArray(req.body.items, 'Itemized expenses') : undefined,
      paidBy: req.body.paidBy || req.user._id,
      proofBuffer: req.file?.buffer || null,
      type: req.body.type === 'REIMBURSEMENT' ? 'REIMBURSEMENT' : 'EXPENSE',
      category: req.body.category || 'Uncategorized',
      subcategory: req.body.subcategory || null,
    },
  });
  res.status(201).json({ data: expense });
};

export const updateFriendExpense = async (req, res) => {
  validateExpenseOptions(req.body);
  const expense = await updateExpense({
    ...req.body,
    expenseId: req.params.expenseId,
    editorId: req.user._id,
    friendId: req.params.friendId,
    participants: parseArray(req.body.participants, 'Participants'),
    values: req.body.values ? parseArray(req.body.values, 'Split values') : undefined,
    items: req.body.items ? parseArray(req.body.items, 'Itemized expenses') : [],
    paidBy: req.body.paidBy,
    proofBuffer: req.file?.buffer || null,
    removePaymentProof: req.body.removePaymentProof === 'true',
    category: req.body.category || 'Uncategorized',
    subcategory: req.body.subcategory || null,
  });
  res.json({ data: expense });
};

export const deleteFriendExpense = async (req, res) => {
  res.json({
    data: await deleteExpense({
      expenseId: req.params.expenseId,
      userId: req.user._id,
      friendId: req.params.friendId,
    }),
  });
};

export const settleFriend = async (req, res) => {
  res.status(201).json({
    data: await settleFriendBalances({
      userId: req.user._id,
      friendId: req.params.friendId,
      payerId: req.body?.payerId,
      amount: req.body?.amount,
      currency: req.body?.currency,
      mode: req.body?.mode,
      selections: req.body?.selections,
      note: req.body?.note || null,
    }),
  });
};


export const listFriendRequests = async (req, res) => {
  const result = await query(
    `SELECT r.id AS "_id", r.status, r.created_at AS "createdAt", r.updated_at AS "updatedAt",
            u.id AS "senderId", u.username AS "senderUsername", u.fullnamae AS "senderName", u.coverimage AS "senderPhoto"
     FROM friend_requests r
     JOIN users u ON u.id = r.sender_id
     WHERE r.receiver_id = $1
     ORDER BY r.created_at DESC
     LIMIT 100`,
    [req.user._id],
  );
  res.json({ data: result.rows   });
};

export const listSentFriendRequests = async (req, res) => {
  const result = await query(
    `SELECT r.id AS "_id", r.status, r.created_at AS "createdAt", r.updated_at AS "updatedAt",
            u.id AS "recipientId", u.username AS "recipientUsername",
            u.fullnamae AS "recipientName", u.coverimage AS "recipientPhoto"
     FROM friend_requests r
     JOIN users u ON u.id = r.receiver_id
     WHERE r.sender_id = $1
     ORDER BY r.created_at DESC
     LIMIT 100`,
    [req.user._id],
  );
  res.json({ data: result.rows });
};

export const sendFriendRequest = async (req, res) => {
  const { userId, username, email } = req.body || {};
  const hasUserId = typeof userId === 'string';
  const hasUsername = typeof username === 'string';
  const hasEmail = typeof email === 'string';
  if ([hasUserId, hasUsername, hasEmail].filter(Boolean).length !== 1) {
    throw Object.assign(new Error('Provide either a username, user ID, or email address'), { statusCode: 400 });
  }
  const identifier = (hasUserId ? userId : hasUsername ? username : email).trim();
  if (!identifier) throw Object.assign(new Error('Username, user ID, or email address is required'), { statusCode: 400 });

  try {
    const request = await withTransaction(async (client) => {
      const recipientResult = hasUserId
        ? await client.query(
          'SELECT id AS "_id", username, fullnamae FROM users WHERE id::text = $1',
          [identifier],
        )
        : hasUsername
          ? await client.query(
            'SELECT id AS "_id", username, fullnamae FROM users WHERE LOWER(username) = LOWER($1)',
            [identifier],
          )
        : await client.query(
          'SELECT id AS "_id", username, fullnamae FROM users WHERE LOWER(email) = LOWER($1)',
          [identifier],
        );
      const recipient = recipientResult.rows[0];
      if (!recipient) {
        const message = hasEmail
          ? 'No SplitCare account is registered with that email address'
          : 'No SplitCare user found with that username';
        throw Object.assign(new Error(message), { statusCode: 404 });
      }
      if (recipient._id === req.user._id) {
        throw Object.assign(new Error('You cannot add yourself as a friend'), { statusCode: 400 });
      }

      const [userLow, userHigh] = friendKey(req.user._id, recipient._id);
      const friendship = await client.query(
        'SELECT 1 FROM friendships WHERE user_low = $1 AND user_high = $2',
        [userLow, userHigh],
      );
      if (friendship.rowCount) throw Object.assign(new Error('You are already friends'), { statusCode: 409 });

      const pendingRequest = await client.query(
        `SELECT 1 FROM friend_requests
         WHERE status = 'pending'
           AND LEAST(sender_id, receiver_id) = $1
           AND GREATEST(sender_id, receiver_id) = $2`,
        [userLow, userHigh],
      );
      if (pendingRequest.rowCount) {
        throw Object.assign(new Error('A friend request is already pending for this user'), { statusCode: 409 });
      }

      const inserted = await client.query(
        `INSERT INTO friend_requests (sender_id, receiver_id)
         VALUES ($1, $2)
         RETURNING id AS "_id", status, created_at AS "createdAt"`,
        [req.user._id, recipient._id],
      );
      return { ...inserted.rows[0], recipientName: recipient.fullnamae || recipient.username };
    });
    res.status(201).json({ data: request });
  } catch (error) {
    if (error.code === '23505') {
      throw Object.assign(new Error('A friend request is already pending for this user'), { statusCode: 409 });
    }
    throw error;
  }
};

export const respondToFriendRequest = async (req, res) => {
  const { action } = req.body || {};
  if (!['accept', 'decline'].includes(action)) {
    throw Object.assign(new Error('Choose whether to accept or decline the friend request'), { statusCode: 400 });
  }

  const result = await withTransaction(async (client) => {
    const requestResult = await client.query(
      `SELECT id, sender_id, receiver_id, status
       FROM friend_requests
       WHERE id = $1 AND receiver_id = $2
       FOR UPDATE`,
      [req.params.requestId, req.user._id],
    );
    const request = requestResult.rows[0];
    if (!request) throw Object.assign(new Error('Friend request not found'), { statusCode: 404 });
    if (request.status !== 'pending') {
      throw Object.assign(new Error('This friend request has already been answered'), { statusCode: 409 });
    }

    if (action === 'accept') {
      const [userLow, userHigh] = friendKey(request.sender_id, request.receiver_id);
      await client.query(
        'INSERT INTO friendships (user_low, user_high) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userLow, userHigh],
      );
    }
    const updated = await client.query(
      `UPDATE friend_requests SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id AS "_id", status`,
      [action === 'accept' ? 'accepted' : 'declined', request.id],
    );
    return updated.rows[0];
  });
  res.json({ data: result });
};

export const removeFriend = async (req, res) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.friendId)) {
    throw Object.assign(new Error('Friend not found'), { statusCode: 404 });
  }
  if (req.params.friendId === req.user._id) {
    throw Object.assign(new Error('You cannot remove yourself as a friend'), { statusCode: 400 });
  }

  const [userLow, userHigh] = friendKey(req.user._id, req.params.friendId);
  const result = await query(
    'DELETE FROM friendships WHERE user_low = $1 AND user_high = $2 RETURNING user_low',
    [userLow, userHigh],
  );
  if (!result.rowCount) throw Object.assign(new Error('Friend not found'), { statusCode: 404 });

  res.json({ data: { message: 'Friend removed. You can send a new friend request later.' } });
};
