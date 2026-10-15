import { SplitStrategyFactory } from './splitStrategies.js';
import Decimal from 'decimal.js';
import { query, withTransaction } from '../db/index.js';
import { eventEmitter, EVENTS } from '../events/eventEmitter.js';
import { uploadImageBuffer } from '../config/cloudinary.js';
import { ensurePersonalExpenseGroup } from './groupService.js';

const expenseSubcategories = {
  Entertainment: ['Games', 'Music', 'Movies', 'Sports', 'Events'],
  'Food and drink': ['Dining out', 'Groceries', 'Drinks', 'Coffee', 'Takeaway'],
  Home: ['Furniture', 'Household supplies', 'Rent', 'Repairs', 'Pets'],
  Life: ['Gifts', 'Health', 'Education', 'Clothing', 'Personal'],
  Transportation: ['Fuel', 'Public transit', 'Taxi', 'Parking', 'Flights'],
  Uncategorized: [],
  Utilities: ['Electricity', 'Internet', 'Water', 'Phone', 'Waste'],
};

export const listExpenses = async (groupId, userId, unlimited = false) => {
  if (groupId) {
    const membership = await query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, userId],
    );
    if (!membership.rowCount) {
      throw Object.assign(new Error('Group or membership not found'), { statusCode: 404 });
    }
  }
  const result = await query(
    `SELECT e.id AS "_id", e.group_id AS "groupId", e.description,
            e.total_amount::text AS "totalAmount", e.currency, e.type,
            e.category, e.subcategory,
            e.split_strategy AS "splitStrategy", e.paid_by AS "paidBy",
            e.created_at AS "createdAt", e.note, e.payment_proof_url AS "paymentProofUrl",
            u.username AS "paidByUsername", u.fullnamae AS "paidByName",
            ARRAY(SELECT es.user_id::text FROM expense_splits es WHERE es.expense_id = e.id) AS "participantIds",
            COALESCE((SELECT json_agg(json_build_object(
              'userId', es.user_id::text,
              'amountOwed', es.amount_owed::text,
              'splitValue', es.split_value::text
            ) ORDER BY es.user_id) FROM expense_splits es WHERE es.expense_id = e.id), '[]'::json) AS splits,
            COALESCE((SELECT json_agg(json_build_object(
              'description', ei.description,
              'amount', ei.amount::text,
              'participantIds', ARRAY(SELECT eis.user_id::text FROM expense_item_splits eis WHERE eis.item_id = ei.id)
            ) ORDER BY ei.created_at) FROM expense_items ei WHERE ei.expense_id = e.id), '[]'::json) AS items,
            COALESCE((SELECT json_agg(json_build_object(
              '_id', ec.id,
              'userId', ec.user_id,
              'authorName', comment_author.fullnamae,
              'content', ec.content,
              'createdAt', ec.created_at
            ) ORDER BY ec.created_at) FROM expense_comments ec
              JOIN users comment_author ON comment_author.id = ec.user_id
              WHERE ec.expense_id = e.id), '[]'::json) AS comments
     FROM expenses e JOIN users u ON u.id = e.paid_by
     ${groupId
			? 'WHERE e.group_id = $1'
			: `WHERE (e.paid_by = $1 OR EXISTS (
		          SELECT 1 FROM expense_splits es WHERE es.expense_id = e.id AND es.user_id = $1
		        ))`}
     ORDER BY e.created_at DESC${unlimited ? '' : ' LIMIT 100'}`,
    [groupId || userId],
  );
  if (!groupId) return result.rows;

  const settlements = await query(
    `SELECT s.id AS "_id", s.group_id AS "groupId",
            'Settlement to ' || recipient.fullnamae AS description,
            s.amount::text AS "totalAmount", s.currency, 'SETTLEMENT' AS type,
            'Settlement' AS category, NULL::text AS subcategory,
            'SETTLEMENT' AS "splitStrategy", s.paid_by AS "paidBy",
            s.created_at AS "createdAt", s.note,
            s.payment_proof_url AS "paymentProofUrl",
            payer.username AS "paidByUsername", payer.fullnamae AS "paidByName",
            ARRAY[s.paid_by::text, s.paid_to::text] AS "participantIds",
            '[]'::json AS items, s.paid_to AS "paidTo",
            recipient.username AS "paidToUsername", recipient.fullnamae AS "paidToName"
     FROM group_settlements s
     JOIN users payer ON payer.id = s.paid_by
     JOIN users recipient ON recipient.id = s.paid_to
     WHERE s.group_id = $1`,
    [groupId],
  );
  return [...result.rows, ...settlements.rows]
    .sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt))
    .slice(0, unlimited ? undefined : 100);
};

export const listPersonalExpenses = async (userId) => {
  const personalGroup = await query(
    'SELECT id FROM groups WHERE created_by = $1 AND is_personal = TRUE',
    [userId],
  );
  if (!personalGroup.rowCount) return [];
  return listExpenses(personalGroup.rows[0].id, userId, true);
};

export const addExpenseComment = async ({ expenseId, userId, content }) => withTransaction(async (client) => {
  const expense = await client.query(
    `SELECT e.group_id AS "groupId", g.is_personal AS "isPersonal"
     FROM expenses e JOIN groups g ON g.id = e.group_id
     WHERE e.id = $1 AND e.type <> 'SETTLEMENT'`,
    [expenseId],
  );
  if (!expense.rowCount) throw Object.assign(new Error('Expense not found'), { statusCode: 404 });
  const membership = await client.query(
    'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
    [expense.rows[0].groupId, userId],
  );
  if (!membership.rowCount) throw Object.assign(new Error('Only group members can comment on this expense'), { statusCode: 403 });
  const result = await client.query(
    `INSERT INTO expense_comments (expense_id, user_id, content)
     VALUES ($1,$2,$3)
     RETURNING id AS "_id", user_id AS "userId", content, created_at AS "createdAt"`,
    [expenseId, userId, content.trim()],
  );
  const author = await client.query('SELECT fullnamae AS "authorName" FROM users WHERE id = $1', [userId]);
  return { ...result.rows[0], authorName: author.rows[0].authorName };
});

export const deleteExpenseComment = async ({ commentId, userId }) => withTransaction(async (client) => {
  const result = await client.query(
    `DELETE FROM expense_comments ec
     USING expenses e, group_members gm
     WHERE ec.id = $1 AND ec.user_id = $2
       AND e.id = ec.expense_id AND gm.group_id = e.group_id AND gm.user_id = $2
     RETURNING ec.id AS "_id"`,
    [commentId, userId],
  );
  if (!result.rowCount) throw Object.assign(new Error('Comment not found or you cannot delete it'), { statusCode: 404 });
  return { _id: result.rows[0]._id, deleted: true };
});

const calculateExpenseShares = ({
  paidBy, totalAmount, splitStrategy, participants, values, items = [],
  description, currency, category, subcategory, note,
}) => {
  const invalid = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  if (typeof description !== 'string' || !description.trim()) invalid('Expense description is required');
  if (!Number.isFinite(Number(totalAmount)) || Number(totalAmount) <= 0) invalid('Expense amount must be greater than zero');
  if (!['INR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD'].includes(currency)) invalid('Choose a supported expense currency');
  if (note !== null && note !== undefined && typeof note !== 'string') invalid('Expense note must be text');
  if (!['Entertainment', 'Food and drink', 'Home', 'Life', 'Transportation', 'Uncategorized', 'Utilities'].includes(category)) {
    invalid('Choose a supported expense category');
  }
  if (subcategory !== null && subcategory !== undefined && typeof subcategory !== 'string') invalid('Expense subcategory must be text');
  if (subcategory && !expenseSubcategories[category].includes(subcategory)) invalid('Choose a supported subcategory for this expense category');
  if (!['EQUAL', 'EXACT', 'PERCENTAGE', 'SHARES', 'ADJUSTMENT', 'REIMBURSEMENT', 'ITEMIZED'].includes(splitStrategy)) {
    invalid('Choose a supported expense split method');
  }
  if (!Array.isArray(participants) || !participants.length || new Set(participants).size !== participants.length) {
    invalid('Choose at least one unique participant');
  }
  if (typeof paidBy !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(paidBy)
    || participants.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) {
    invalid('Payer and participant IDs must be valid');
  }
  let splits;
  const itemSplits = [];
  if (splitStrategy === 'ITEMIZED') {
    if (!Array.isArray(items) || !items.length) invalid('Add at least one item to an itemized expense');
    const totals = new Map(participants.map((id) => [id, 0]));
    for (const item of items) {
      if (typeof item.description !== 'string' || !item.description.trim() || !Number.isFinite(Number(item.amount)) || Number(item.amount) <= 0) {
        invalid('Each item needs a description and a positive amount');
      }
      if (!Array.isArray(item.participantIds) || !item.participantIds.length
        || new Set(item.participantIds).size !== item.participantIds.length
        || item.participantIds.some((id) => !participants.includes(id))) {
        invalid('Each item must be assigned to at least one selected participant');
      }
      const itemShares = SplitStrategyFactory.get('EQUAL').calculateSplits(item.amount, item.participantIds);
      itemSplits.push({ ...item, splits: itemShares });
      itemShares.forEach((split) => {
        totals.set(split.userId, totals.get(split.userId) + Number(split.amountOwed.toFixed(2)));
      });
    }
    splits = SplitStrategyFactory.get('ITEMIZED').calculateSplits(
      totalAmount,
      participants,
      participants.map((id) => totals.get(id).toFixed(2)),
    );
  } else {
    splits = SplitStrategyFactory.get(splitStrategy).calculateSplits(totalAmount, participants, values);
  }
  return { splits, itemSplits };
};

const saveExpenseItems = async (client, expenseId, itemSplits) => {
  for (const item of itemSplits) {
    const createdItem = await client.query(
      'INSERT INTO expense_items (expense_id, description, amount) VALUES ($1,$2,$3) RETURNING id',
      [expenseId, item.description.trim(), item.amount],
    );
    for (const split of item.splits) {
      await client.query(
        'INSERT INTO expense_item_splits (item_id, user_id, amount_owed) VALUES ($1,$2,$3)',
        [createdItem.rows[0].id, split.userId, split.amountOwed.toString()],
      );
    }
  }
};

const applyGroupBalances = async (client, { groupId, paidBy, currency, splits, multiplier }) => {
  for (const split of splits) {
    if (split.userId === paidBy) continue;
    const [user1, user2] = [paidBy, split.userId].sort();
    const direction = user1 === paidBy ? 1 : -1;
    const delta = split.amountOwed.mul(direction * multiplier).toString();
    await client.query(
      `INSERT INTO balances (group_id,user1,user2,currency,net_owed) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (group_id,user1,user2,currency)
       DO UPDATE SET net_owed = balances.net_owed + EXCLUDED.net_owed, updated_at = NOW()`,
      [groupId, user1, user2, currency, delta],
    );
  }
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
  const isPersonal = !groupId;
  if (isPersonal) {
    if (paidBy !== participants?.[0] || participants?.length !== 1) {
      throw Object.assign(new Error('Personal expenses can only include your account'), { statusCode: 400 });
    }
  }
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
  if (isPersonal) groupId = (await ensurePersonalExpenseGroup(paidBy))._id;
  const expense = await withTransaction(async (client) => {
    if (!isPersonal) {
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

export const updateExpense = async ({
  expenseId,
  editorId,
  description,
  totalAmount,
  currency,
  category,
  subcategory = null,
  paidBy,
  participants,
  splitStrategy,
  values,
  items = [],
  note = null,
  proofBuffer = null,
  removePaymentProof = false,
}) => {
  const { splits, itemSplits } = calculateExpenseShares({
    paidBy, totalAmount, splitStrategy, participants, values, items,
    description, currency, category, subcategory, note,
  });
  const updated = await withTransaction(async (client) => {
    const existingResult = await client.query(
      `SELECT e.id AS "_id", e.group_id AS "groupId", e.paid_by AS "paidBy",
              e.currency, e.type, e.payment_proof_url AS "paymentProofUrl",
              g.name AS "groupName", g.is_personal AS "isPersonal",
              COALESCE((SELECT json_agg(json_build_object(
                'userId', es.user_id::text,
                'amountOwed', es.amount_owed::text,
                'splitValue', es.split_value::text
              ) ORDER BY es.user_id) FROM expense_splits es WHERE es.expense_id = e.id), '[]'::json) AS splits
       FROM expenses e
       JOIN groups g ON g.id = e.group_id
       WHERE e.id = $1
       FOR UPDATE OF e`,
      [expenseId],
    );
    const existing = existingResult.rows[0];
    if (!existing || existing.type === 'SETTLEMENT') {
      throw Object.assign(new Error('Expense not found'), { statusCode: 404 });
    }
    const membership = await client.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [existing.groupId, editorId],
    );
    if (!membership.rowCount) {
      throw Object.assign(new Error('Only group members can edit this expense'), { statusCode: 403 });
    }
    if (existing.isPersonal && editorId !== existing.paidBy) {
      throw Object.assign(new Error('Only the account owner can edit a personal expense'), { statusCode: 403 });
    }
    const allowed = await client.query(
      'SELECT user_id FROM group_members WHERE group_id = $1 AND user_id = ANY($2::uuid[])',
      [existing.groupId, [...new Set([paidBy, ...participants])]],
    );
    if (allowed.rowCount !== new Set([paidBy, ...participants]).size) {
      throw Object.assign(new Error('Payer and participants must belong to the group'), { statusCode: 400 });
    }

    const previousSplits = existing.splits.map((split) => ({
      userId: split.userId,
      amountOwed: new Decimal(split.amountOwed),
    }));
    await applyGroupBalances(client, {
      groupId: existing.groupId,
      paidBy: existing.paidBy,
      currency: existing.currency,
      splits: previousSplits,
      multiplier: -1,
    });

    const proofUrl = proofBuffer
      ? await uploadImageBuffer(proofBuffer, 'splitcare/expense-proofs')
      : removePaymentProof ? null : existing.paymentProofUrl;
    await client.query(
      `UPDATE expenses
       SET description = $1, total_amount = $2, currency = $3, split_strategy = $4,
           paid_by = $5, type = $6, category = $7, subcategory = $8,
           note = $9, payment_proof_url = $10
       WHERE id = $11`,
      [description.trim(), totalAmount, currency, splitStrategy, paidBy,
        splitStrategy === 'REIMBURSEMENT' ? 'REIMBURSEMENT' : 'EXPENSE',
        category, subcategory?.trim() || null, note?.trim() || null, proofUrl, expenseId],
    );
    await client.query('DELETE FROM expense_splits WHERE expense_id = $1', [expenseId]);
    await client.query('DELETE FROM expense_items WHERE expense_id = $1', [expenseId]);
    await saveExpenseItems(client, expenseId, itemSplits);
    for (const split of splits) {
      await client.query(
        'INSERT INTO expense_splits (expense_id, user_id, amount_owed, split_value) VALUES ($1,$2,$3,$4)',
        [expenseId, split.userId, split.amountOwed.toString(), split.splitValue.toString()],
      );
    }
    await applyGroupBalances(client, {
      groupId: existing.groupId,
      paidBy,
      currency,
      splits,
      multiplier: 1,
    });

    const editor = await client.query('SELECT fullnamae FROM users WHERE id = $1', [editorId]);
    const message = `${editor.rows[0]?.fullnamae || 'A group member'} edited "${description.trim()}" in ${existing.groupName}.`;
    await client.query(
      `INSERT INTO notifications (user_id, group_id, expense_id, message, created_by)
       SELECT user_id, $1, $2, $3, $4 FROM group_members WHERE group_id = $1`,
      [existing.groupId, expenseId, message, editorId],
    );
    return {
      _id: expenseId,
      groupId: existing.groupId,
      description: description.trim(),
      totalAmount: String(totalAmount),
      currency,
      type: splitStrategy === 'REIMBURSEMENT' ? 'REIMBURSEMENT' : 'EXPENSE',
      splitStrategy,
      paidBy,
      category,
      subcategory: subcategory?.trim() || null,
      note: note?.trim() || null,
      paymentProofUrl: proofUrl,
    };
  });
  eventEmitter.emit(EVENTS.EXPENSE_UPDATED, updated);
  return updated;
};
