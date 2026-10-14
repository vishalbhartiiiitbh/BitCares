import { query, withTransaction } from '../db/index.js';

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
  res.json({ data: result.rows });
};

export const sendFriendRequest = async (req, res) => {
  const { userId, email } = req.body || {};
  const hasUserId = typeof userId === 'string';
  const hasEmail = typeof email === 'string';
  if (hasUserId === hasEmail) {
    throw Object.assign(new Error('Provide either a user ID or an email address'), { statusCode: 400 });
  }
  const identifier = (hasUserId ? userId : email).trim();
  if (!identifier) throw Object.assign(new Error('User ID or email address is required'), { statusCode: 400 });

  try {
    const request = await withTransaction(async (client) => {
      const recipientResult = hasUserId
        ? await client.query(
          'SELECT id AS "_id", username, fullnamae FROM users WHERE id::text = $1',
          [identifier],
        )
        : await client.query(
          'SELECT id AS "_id", username, fullnamae FROM users WHERE LOWER(email) = LOWER($1)',
          [identifier],
        );
      const recipient = recipientResult.rows[0];
      if (!recipient) throw Object.assign(new Error('No SplitCare user found with those details'), { statusCode: 404 });
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
