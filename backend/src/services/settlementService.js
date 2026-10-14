import Decimal from 'decimal.js';
import { withTransaction } from '../db/index.js';
import { uploadImageBuffer } from '../config/cloudinary.js';

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
    const group = await client.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE', [groupId]);
    if (!group.rowCount) throw Object.assign(new Error('Group not found'), { statusCode: 404 });

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
    return result.rows[0];
  });
};
