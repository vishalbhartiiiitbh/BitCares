import Decimal from 'decimal.js';
import { withTransaction } from '../db/index.js';
import { simplifyDebts } from './debtSimplifier.js';

const validId = (id) => typeof id === 'string'
  && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);

export const createPaymentRequest = async ({
  groupId,
  requesterId,
  memberId,
  amount,
  currency,
  note = null,
}) => {
  if (!validId(groupId) || !validId(requesterId) || !validId(memberId) || requesterId === memberId) {
    throw Object.assign(new Error('Choose a valid group member to request payment from'), { statusCode: 400 });
  }
  let requestAmount;
  try {
    requestAmount = new Decimal(amount);
  } catch {
    throw Object.assign(new Error('Enter a valid request amount'), { statusCode: 400 });
  }
  if (!requestAmount.isFinite() || requestAmount.lte(0) || requestAmount.decimalPlaces() > 2) {
    throw Object.assign(new Error('Request amount must be greater than zero and use at most two decimal places'), { statusCode: 400 });
  }
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw Object.assign(new Error('Choose a valid payment currency'), { statusCode: 400 });
  }
  if (note !== null && (typeof note !== 'string' || note.length > 1000)) {
    throw Object.assign(new Error('Request note must be text of 1,000 characters or fewer'), { statusCode: 400 });
  }

  const plan = await simplifyDebts(groupId, requesterId);
  const debt = plan.find((transfer) => (
    transfer.from === memberId && transfer.to === requesterId && transfer.currency === currency
  ));
  if (!debt) {
    throw Object.assign(new Error('This member does not currently owe you in the selected currency'), { statusCode: 400 });
  }
  if (requestAmount.gt(debt.amount)) {
    throw Object.assign(new Error(`Request cannot exceed the outstanding amount of ${currency} ${debt.amount}`), { statusCode: 400 });
  }

  return withTransaction(async (client) => {
    const membership = await client.query(
      `SELECT g.name AS "groupName"
       FROM groups g
       JOIN group_members requester ON requester.group_id = g.id AND requester.user_id = $2
       JOIN group_members member ON member.group_id = g.id AND member.user_id = $3
       WHERE g.id = $1 AND NOT g.is_personal`,
      [groupId, requesterId, memberId],
    );
    if (!membership.rowCount) {
      throw Object.assign(new Error('Both people must belong to this group'), { statusCode: 400 });
    }

    const users = await client.query(
      'SELECT id, fullnamae, username FROM users WHERE id = ANY($1::uuid[])',
      [[requesterId, memberId]],
    );
    const usersById = new Map(users.rows.map((user) => [user.id, user]));
    const requester = usersById.get(requesterId);
    const recipient = usersById.get(memberId);
    const requesterName = requester?.fullnamae || requester?.username || 'A group member';
    const recipientName = recipient?.fullnamae || recipient?.username || 'a group member';
    const formattedAmount = requestAmount.toFixed(2);
    const trimmedNote = note?.trim() || null;
    const details = `${requesterName} requested ${currency} ${formattedAmount} from ${recipientName}${trimmedNote ? `: ${trimmedNote}` : ''}.`;
    const description = `Payment requested from ${recipientName}`;
    const activityResult = await client.query(
      `INSERT INTO group_activity
         (group_id, actor_id, activity_type, description, details, amount, currency)
       VALUES ($1, $2, 'PAYMENT_REQUESTED', $3, $4, $5, $6)
       RETURNING id AS "_id", group_id AS "groupId", activity_type AS "activityType",
                 'ACTIVITY' AS type, description, details, amount::text AS "totalAmount",
                 currency, created_at AS "createdAt", actor_id AS "paidBy"`,
      [groupId, requesterId, description, details, formattedAmount, currency],
    );
    const notificationResult = await client.query(
      `INSERT INTO notifications (user_id, group_id, message, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id AS "_id", group_id AS "groupId", message, created_at AS "createdAt",
                 read_at AS "readAt"`,
      [memberId, groupId, details, requesterId],
    );
    const activity = activityResult.rows[0];
    activity.paidByName = requesterName;
    activity.paidByUsername = requester?.username;
    return {
      activity,
      notification: notificationResult.rows[0],
      recipientName,
    };
  });
};
