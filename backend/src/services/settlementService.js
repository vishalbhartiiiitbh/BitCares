import Decimal from 'decimal.js';
import { withTransaction } from '../db/index.js';
import { uploadImageBuffer } from '../config/cloudinary.js';
import { queueEmailNotification } from './emailNotificationService.js';

const validId = (id) => typeof id === 'string'
  && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);

export const recordSettlement = async ({
  groupId,
  payerId,
  payeeId,
  amount,
  currency,
  note = null,
  proofBuffer = null,
}) => {
  if (!validId(groupId) || !validId(payerId) || !validId(payeeId) || payerId === payeeId) {
    throw Object.assign(new Error('Choose a valid group member to receive the payment'), { statusCode: 400 });
  }
  let settlementAmount;
  try {
    settlementAmount = new Decimal(amount);
  } catch {
    throw Object.assign(new Error('Enter a valid settlement amount'), { statusCode: 400 });
  }
  if (!settlementAmount.isFinite() || settlementAmount.lte(0) || settlementAmount.decimalPlaces() > 2) {
    throw Object.assign(new Error('Settlement amount must be greater than zero and use at most two decimal places'), { statusCode: 400 });
  }
  if (!['INR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD'].includes(currency)) {
    throw Object.assign(new Error('Choose a supported settlement currency'), { statusCode: 400 });
  }
  if (note !== null && typeof note !== 'string') {
    throw Object.assign(new Error('Settlement note must be text'), { statusCode: 400 });
  }

  return withTransaction(async (client) => {
    const group = await client.query(
      'SELECT id, simplify_debts AS "simplifyDebts", is_friend_ledger AS "isFriendLedger" FROM groups WHERE id = $1 FOR UPDATE',
      [groupId],
    );
    if (!group.rowCount) throw Object.assign(new Error('Group not found'), { statusCode: 404 });
    if (group.rows[0].isFriendLedger) {
      throw Object.assign(new Error('Use the friend history page to settle a private friend ledger'), { statusCode: 404 });
    }

    const members = await client.query(
      'SELECT user_id FROM group_members WHERE group_id = $1 AND user_id = ANY($2::uuid[])',
      [groupId, [payerId, payeeId]],
    );
    if (members.rowCount !== 2) {
      throw Object.assign(new Error('Payer and recipient must both belong to this group'), { statusCode: 400 });
    }

    const [user1, user2] = [payerId, payeeId].sort();
    const balanceResult = await client.query(
      'SELECT net_owed::text AS amount FROM balances WHERE group_id = $1 AND user1 = $2 AND user2 = $3 AND currency = $4 FOR UPDATE',
      [groupId, user1, user2, currency],
    );
    const currentBalance = new Decimal(balanceResult.rows[0]?.amount || 0);
    if (group.rows[0].simplifyDebts) {
      // In simplified mode, validate against members' overall net positions, not one pairwise row.
      const allBalances = await client.query(
        'SELECT user1, user2, net_owed::text AS amount FROM balances WHERE group_id = $1 AND currency = $2',
        [groupId, currency],
      );
      const netByMember = new Map();
      for (const balance of allBalances.rows) {
        const amount = new Decimal(balance.amount);
        netByMember.set(balance.user1, (netByMember.get(balance.user1) || new Decimal(0)).plus(amount));
        netByMember.set(balance.user2, (netByMember.get(balance.user2) || new Decimal(0)).minus(amount));
      }
      const payerNet = netByMember.get(payerId) || new Decimal(0);
      const payeeNet = netByMember.get(payeeId) || new Decimal(0);
      if (!payerNet.isNegative() || !payeeNet.isPositive()) {
        throw Object.assign(new Error('The simplified plan does not show this payment as an amount you owe'), { statusCode: 400 });
      }
      const maximumSettlement = Decimal.min(payerNet.abs(), payeeNet);
      if (settlementAmount.gt(maximumSettlement)) {
        throw Object.assign(new Error(`Settlement cannot exceed the suggested amount of ${currency} ${maximumSettlement.toFixed(2)}`), { statusCode: 400 });
      }
      const delta = payerId === user1 ? settlementAmount : settlementAmount.negated();
      await client.query(
        `INSERT INTO balances (group_id, user1, user2, currency, net_owed)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (group_id, user1, user2, currency)
         DO UPDATE SET net_owed = balances.net_owed + EXCLUDED.net_owed, updated_at = NOW()`,
        [groupId, user1, user2, currency, delta.toFixed(2)],
      );
    } else {
      const payerOwesPayee = payerId === user1 ? currentBalance.isNegative() : currentBalance.isPositive();
      if (!payerOwesPayee || currentBalance.isZero()) {
        throw Object.assign(new Error('The selected payer does not owe this member in the selected currency'), { statusCode: 400 });
      }
      if (settlementAmount.gt(currentBalance.abs())) {
        throw Object.assign(new Error(`Settlement cannot exceed the outstanding amount of ${currency} ${currentBalance.abs().toFixed(2)}`), { statusCode: 400 });
      }

      const updatedBalance = payerId === user1
        ? currentBalance.plus(settlementAmount)
        : currentBalance.minus(settlementAmount);
      await client.query(
        'UPDATE balances SET net_owed = $1, updated_at = NOW() WHERE group_id = $2 AND user1 = $3 AND user2 = $4 AND currency = $5',
        [updatedBalance.toFixed(2), groupId, user1, user2, currency],
      );
    }

    const proofUrl = proofBuffer
      ? await uploadImageBuffer(proofBuffer, 'splitcare/settlement-proofs')
      : null;
    const result = await client.query(
      `INSERT INTO group_settlements (group_id, paid_by, paid_to, amount, currency, note, payment_proof_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id AS "_id", group_id AS "groupId", paid_by AS "paidBy", paid_to AS "paidTo",
                 amount::text AS "totalAmount", currency, note,
                 payment_proof_url AS "paymentProofUrl", created_at AS "createdAt"`,
      [groupId, payerId, payeeId, settlementAmount.toFixed(2), currency, note?.trim() || null, proofUrl],
    );
    const payer = await client.query('SELECT fullnamae FROM users WHERE id = $1', [payerId]);
    const payee = await client.query('SELECT fullnamae FROM users WHERE id = $1', [payeeId]);
    const activityDetails = `${payer.rows[0]?.fullnamae || 'A group member'} paid ${payee.rows[0]?.fullnamae || 'a group member'} ${currency} ${settlementAmount.toFixed(2)}.`;
    await client.query(
      `INSERT INTO notifications (user_id, group_id, message, created_by, notification_type)
       VALUES ($1, $2, $3, $4, 'PAYMENT_RECEIVED')`,
      [payeeId, groupId, activityDetails, payerId],
    );
    await queueEmailNotification(client, payeeId, 'paymentReceived', 'You received a SplitCare payment', activityDetails);
    return result.rows[0];
  });
};
