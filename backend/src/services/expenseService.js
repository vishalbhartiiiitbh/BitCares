import { SplitStrategyFactory } from './splitStrategies.js';
import { query, withTransaction } from '../db/index.js';
import { eventEmitter, EVENTS } from '../events/eventEmitter.js';
import { uploadImageBuffer } from '../config/cloudinary.js';

const expenseSubcategories = {
  Entertainment: ['Games', 'Music', 'Movies', 'Sports', 'Events'],
  'Food and drink': ['Dining out', 'Groceries', 'Drinks', 'Coffee', 'Takeaway'],
  Home: ['Furniture', 'Household supplies', 'Rent', 'Repairs', 'Pets'],
  Life: ['Gifts', 'Health', 'Education', 'Clothing', 'Personal'],
  Transportation: ['Fuel', 'Public transit', 'Taxi', 'Parking', 'Flights'],
  Uncategorized: [],
  Utilities: ['Electricity', 'Internet', 'Water', 'Phone', 'Waste'],
};

export const listExpenses = async (groupId) => {
  const result = await query(
    `SELECT e.id AS "_id", e.group_id AS "groupId", e.description,
            e.total_amount::text AS "totalAmount", e.currency, e.type,
            e.category, e.subcategory,
            e.split_strategy AS "splitStrategy", e.paid_by AS "paidBy",
            e.created_at AS "createdAt", e.note, e.payment_proof_url AS "paymentProofUrl",
            u.username AS "paidByUsername", u.fullnamae AS "paidByName",
            ARRAY(SELECT es.user_id::text FROM expense_splits es WHERE es.expense_id = e.id) AS "participantIds",
            COALESCE((SELECT json_agg(json_build_object(
              'description', ei.description,
              'amount', ei.amount::text,
              'participantIds', ARRAY(SELECT eis.user_id::text FROM expense_item_splits eis WHERE eis.item_id = ei.id)
            ) ORDER BY ei.created_at) FROM expense_items ei WHERE ei.expense_id = e.id), '[]'::json) AS items
     FROM expenses e JOIN users u ON u.id = e.paid_by
     ${groupId ? 'WHERE e.group_id = $1' : ''}
     ORDER BY e.created_at DESC LIMIT 100`,
    groupId ? [groupId] : [],
  );
  return result.rows;
};

export const addExpense = async ({
  groupId = null,
  paidBy,
  totalAmount,
  splitStrategy,
  participants,
  values,
  items = [],
  description,
  currency = 'INR',
  note = null,
  proofBuffer = null,
  type = 'EXPENSE',
  category = 'Uncategorized',
  subcategory = null,
}) => {
  groupId = groupId || null;
  if (!Array.isArray(participants) || !participants.length || new Set(participants).size !== participants.length) {
    throw Object.assign(new Error('Choose at least one unique participant'), { statusCode: 400 });
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw Object.assign(new Error('Expense description is required'), { statusCode: 400 });
  }
  if (!Number.isFinite(Number(totalAmount)) || Number(totalAmount) <= 0) {
    throw Object.assign(new Error('Expense amount must be greater than zero'), { statusCode: 400 });
  }
  if (!['INR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD'].includes(currency)) {
    throw Object.assign(new Error('Choose a supported expense currency'), { statusCode: 400 });
  }
  if (typeof paidBy !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(paidBy)
    || participants.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) {
    throw Object.assign(new Error('Payer and participant IDs must be valid'), { statusCode: 400 });
  }
  if (note !== null && typeof note !== 'string') {
    throw Object.assign(new Error('Expense note must be text'), { statusCode: 400 });
  }
  if (!['Entertainment', 'Food and drink', 'Home', 'Life', 'Transportation', 'Uncategorized', 'Utilities'].includes(category)) {
    throw Object.assign(new Error('Choose a supported expense category'), { statusCode: 400 });
  }
  if (subcategory !== null && typeof subcategory !== 'string') {
    throw Object.assign(new Error('Expense subcategory must be text'), { statusCode: 400 });
  }
  if (subcategory && !expenseSubcategories[category].includes(subcategory)) {
    throw Object.assign(new Error('Choose a supported subcategory for this expense category'), { statusCode: 400 });
  }

  let splits;
  let itemSplits = [];
  if (splitStrategy === 'ITEMIZED') {
    if (!Array.isArray(items) || !items.length) {
      throw Object.assign(new Error('Add at least one item to an itemized expense'), { statusCode: 400 });
    }
    const totals = new Map(participants.map((id) => [id, 0]));
    for (const item of items) {
      if (typeof item.description !== 'string' || !item.description.trim() || !Number.isFinite(Number(item.amount)) || Number(item.amount) <= 0) {
        throw Object.assign(new Error('Each item needs a description and a positive amount'), { statusCode: 400 });
      }
      if (!Array.isArray(item.participantIds) || !item.participantIds.length
        || new Set(item.participantIds).size !== item.participantIds.length
        || item.participantIds.some((id) => !participants.includes(id))) {
        throw Object.assign(new Error('Each item must be assigned to at least one selected participant'), { statusCode: 400 });
      }
      const splitsForItem = SplitStrategyFactory.get('EQUAL').calculateSplits(item.amount, item.participantIds);
      itemSplits.push({ ...item, splits: splitsForItem });
      splitsForItem.forEach((split) => {
        totals.set(split.userId, totals.get(split.userId) + Number(split.amountOwed.toFixed(2)));
      });
    }
    const valuesFromItems = participants.map((id) => totals.get(id).toFixed(2));
    splits = SplitStrategyFactory.get('ITEMIZED').calculateSplits(totalAmount, participants, valuesFromItems);
  } else {
    splits = SplitStrategyFactory.get(splitStrategy).calculateSplits(totalAmount, participants, values);
  }
  const expense = await withTransaction(async (client) => {
    if (groupId) {
      const allowed = await client.query(
        'SELECT user_id FROM group_members WHERE group_id = $1 AND user_id = ANY($2::uuid[])',
        [groupId, [...new Set([paidBy, ...participants])]],
      );
      if (allowed.rowCount !== new Set([paidBy, ...participants]).size) {
        throw Object.assign(new Error('Payer and participants must belong to the group'), { statusCode: 400 });
      }
    }
    const proofUrl = proofBuffer
      ? await uploadImageBuffer(proofBuffer, 'splitcare/expense-proofs')
      : null;
    const created = await client.query(
      `INSERT INTO expenses (group_id, description, total_amount, currency, split_strategy, paid_by, type, category, subcategory, note, payment_proof_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id AS "_id", group_id AS "groupId", description, total_amount::text AS "totalAmount",
                 currency, type, split_strategy AS "splitStrategy", paid_by AS "paidBy",
                 category, subcategory, created_at AS "createdAt", note, payment_proof_url AS "paymentProofUrl"`,
      [groupId, description.trim(), totalAmount, currency, splitStrategy, paidBy, type, category, subcategory?.trim() || null, note?.trim() || null, proofUrl],
    );
    const row = created.rows[0];
    for (const item of itemSplits) {
      const createdItem = await client.query(
        'INSERT INTO expense_items (expense_id, description, amount) VALUES ($1,$2,$3) RETURNING id',
        [row._id, item.description.trim(), item.amount],
      );
      for (const split of item.splits) {
        await client.query(
          'INSERT INTO expense_item_splits (item_id, user_id, amount_owed) VALUES ($1,$2,$3)',
          [createdItem.rows[0].id, split.userId, split.amountOwed.toString()],
        );
      }
    }
    for (const split of splits) {
      const amount = split.amountOwed.toString();
      await client.query(
        'INSERT INTO expense_splits (expense_id, user_id, amount_owed, split_value) VALUES ($1,$2,$3,$4)',
        [row._id, split.userId, amount, split.splitValue.toString()],
      );
      if (split.userId !== paidBy && groupId) {
        const [user1, user2] = [paidBy, split.userId].sort();
        const delta = user1 === paidBy ? amount : `-${amount}`;
        await client.query(
          `INSERT INTO balances (group_id,user1,user2,currency,net_owed) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (group_id,user1,user2,currency)
           DO UPDATE SET net_owed = balances.net_owed + EXCLUDED.net_owed, updated_at = NOW()`,
          [groupId, user1, user2, currency, delta],
        );
      }
    }
    return row;
  });
  eventEmitter.emit(EVENTS.EXPENSE_CREATED, expense);
  return expense;
};
