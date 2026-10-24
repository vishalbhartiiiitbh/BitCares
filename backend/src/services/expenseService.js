import { SplitStrategyFactory } from './splitStrategies.js';
import Decimal from 'decimal.js';
import { query, withTransaction } from '../db/index.js';
import { eventEmitter, EVENTS } from '../events/eventEmitter.js';
import { deleteImageByUrl, uploadImageBuffer } from '../config/cloudinary.js';
import { ensurePersonalExpenseGroup } from './groupService.js';
import { recordGroupActivity } from './groupActivityService.js';
import { getExchangeRate } from './exchangeRateService.js';
import { normalizeGroupBalances } from './groupCurrencyService.js';
import { getUserFeatureAccess, isFeatureEnabled } from './featureAccessService.js';

const expenseSubcategories = {
  Entertainment: ['Games', 'Music', 'Movies', 'Sports', 'Events'],
  'Food and drink': ['Dining out', 'Groceries', 'Drinks', 'Coffee', 'Takeaway'],
  Home: ['Furniture', 'Household supplies', 'Rent', 'Repairs', 'Pets'],
  Life: ['Gifts', 'Health', 'Education', 'Clothing', 'Personal'],
  Transportation: ['Fuel', 'Public transit', 'Taxi', 'Parking', 'Flights'],
  Uncategorized: [],
  Utilities: ['Electricity', 'Internet', 'Water', 'Phone', 'Waste'],
};

const convertMoney = (amount, rate) => {
  let decimal;
  try {
    decimal = new Decimal(amount);
  } catch {
    throw Object.assign(new Error('Enter a valid expense amount'), { statusCode: 400 });
  }
  if (!decimal.isFinite() || decimal.lte(0)) {
    throw Object.assign(new Error('Expense amount must be greater than zero'), { statusCode: 400 });
  }
  const converted = decimal.mul(rate).toDecimalPlaces(2);
  if (converted.lte(0)) {
    throw Object.assign(new Error('The converted expense is below the smallest supported amount'), { statusCode: 400 });
  }
  return converted.toFixed(2);
};

const convertSplitValues = (values, splitStrategy, rate) => {
  if (!Array.isArray(values) || !['EXACT', 'REIMBURSEMENT', 'ADJUSTMENT'].includes(splitStrategy)) return values;
  const converted = values.map((value) => {
    let amount;
    try {
      amount = new Decimal(value);
    } catch {
      throw Object.assign(new Error('Split values must be valid numbers'), { statusCode: 400 });
    }
    if (!amount.isFinite()) throw Object.assign(new Error('Split values must be valid numbers'), { statusCode: 400 });
    return amount.mul(rate).toDecimalPlaces(2);
  });
  if (splitStrategy === 'ADJUSTMENT' && converted.length) {
    const sum = converted.reduce((total, value) => total.plus(value), new Decimal(0));
    converted[converted.length - 1] = converted[converted.length - 1].minus(sum);
  }
  return converted.map((value) => value.toFixed(2));
};

const sumAmounts = (amounts) => amounts
  .reduce((total, amount) => total.plus(amount), new Decimal(0))
  .toDecimalPlaces(2)
  .toFixed(2);

export const listExpenses = async (groupId, userId, unlimited = false, includeFriendLedger = false) => {
  if (groupId) {
    const membership = await query(
      `SELECT g.is_friend_ledger AS "isFriendLedger"
       FROM group_members gm JOIN groups g ON g.id = gm.group_id
       WHERE gm.group_id = $1 AND gm.user_id = $2`,
      [groupId, userId],
    );
    if (!membership.rowCount) {
      throw Object.assign(new Error('Group or membership not found'), { statusCode: 404 });
    }
    if (membership.rows[0].isFriendLedger && !includeFriendLedger) {
      throw Object.assign(new Error('Use the friend history page to view this private ledger'), { statusCode: 404 });
    }
    if (!membership.rows[0].isFriendLedger) {
      await normalizeGroupBalances(groupId, userId);
    }
  } else {
    const groups = await query(
      `SELECT g.id
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.user_id = $1 AND NOT g.is_personal AND NOT g.is_friend_ledger`,
      [userId],
    );
    await Promise.all(groups.rows.map((group) => normalizeGroupBalances(group.id, userId)));
  }
  const result = await query(
    `SELECT e.id AS "_id", e.group_id AS "groupId", g.name AS "groupName",
            g.currency AS "groupCurrency", g.is_friend_ledger AS "isFriendLedger",
            g.is_personal AS "isPersonal", e.description,
            e.total_amount::text AS "totalAmount", e.currency, e.type,
            COALESCE(e.original_amount, e.total_amount)::text AS "originalAmount",
            COALESCE(e.original_currency, e.currency) AS "originalCurrency",
            COALESCE(e.conversion_rate, 1)::text AS "conversionRate",
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
     FROM expenses e
     JOIN users u ON u.id = e.paid_by
     JOIN groups g ON g.id = e.group_id
     ${groupId
			? 'WHERE e.group_id = $1'
			: `WHERE (
		          EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = e.group_id AND gm.user_id = $1)
		          OR (g.is_personal AND g.created_by = $1)
		        ) AND NOT g.is_friend_ledger`}
     ORDER BY e.created_at DESC${unlimited ? '' : ' LIMIT 100'}`,
    [groupId || userId],
  );
  if (!groupId) {
    const activity = await query(
      `SELECT a.id AS "_id", a.group_id AS "groupId", g.name AS "groupName",
              a.activity_type AS "activityType", 'ACTIVITY' AS type,
              a.description, a.details, a.amount::text AS "totalAmount",
              a.currency, a.created_at AS "createdAt", a.actor_id AS "paidBy",
              FALSE AS "isPersonal",
              actor.username AS "paidByUsername", actor.fullnamae AS "paidByName",
              ARRAY[]::text[] AS "participantIds", '[]'::json AS splits, '[]'::json AS items
       FROM group_activity a
       JOIN group_members gm ON gm.group_id = a.group_id AND gm.user_id = $1
       JOIN groups g ON g.id = a.group_id
       JOIN users actor ON actor.id = a.actor_id
       WHERE NOT g.is_personal AND NOT g.is_friend_ledger
       ORDER BY a.created_at DESC${unlimited ? '' : ' LIMIT 100'}`,
      [userId],
    );
    const settlements = await query(
      `SELECT s.id AS "_id", s.group_id AS "groupId", g.name AS "groupName",
              FALSE AS "isPersonal",
              'Settlement to ' || recipient.fullnamae AS description,
              s.amount::text AS "totalAmount", s.currency, 'SETTLEMENT' AS type,
              'Settlement' AS category, NULL::text AS subcategory,
              'SETTLEMENT' AS "splitStrategy", s.paid_by AS "paidBy",
              s.created_at AS "createdAt", s.note,
              s.payment_proof_url AS "paymentProofUrl",
              payer.username AS "paidByUsername", payer.fullnamae AS "paidByName",
              ARRAY[s.paid_by::text, s.paid_to::text] AS "participantIds",
              '[]'::json AS items, s.paid_to AS "paidTo",
              recipient.username AS "paidToUsername", recipient.fullnamae AS "paidToName",
              '[]'::json AS splits
       FROM group_settlements s
       JOIN groups g ON g.id = s.group_id AND NOT g.is_personal AND NOT g.is_friend_ledger
       JOIN group_members gm ON gm.group_id = s.group_id AND gm.user_id = $1
       JOIN users payer ON payer.id = s.paid_by
       JOIN users recipient ON recipient.id = s.paid_to
       ORDER BY s.created_at DESC${unlimited ? '' : ' LIMIT 100'}`,
      [userId],
    );
    const friendSettlements = await query(
      `SELECT a.id AS "_id", a.group_id AS "groupId", g.name AS "groupName",
              FALSE AS "isPersonal",
              'Settlement to ' || recipient.fullnamae AS description,
              a.amount::text AS "totalAmount", a.currency, 'SETTLEMENT' AS type,
              'Settlement' AS category, NULL::text AS subcategory,
              'SETTLEMENT' AS "splitStrategy", s.paid_by AS "paidBy",
              s.created_at AS "createdAt", s.note,
              NULL::text AS "paymentProofUrl",
              payer.username AS "paidByUsername", payer.fullnamae AS "paidByName",
              ARRAY[s.paid_by::text, s.paid_to::text] AS "participantIds",
              '[]'::json AS items, s.paid_to AS "paidTo",
              recipient.username AS "paidToUsername", recipient.fullnamae AS "paidToName",
              '[]'::json AS splits
       FROM friend_settlement_allocations a
       JOIN friend_settlements s ON s.id = a.settlement_id
       JOIN groups g ON g.id = a.group_id AND NOT g.is_personal AND NOT g.is_friend_ledger
       JOIN group_members gm ON gm.group_id = a.group_id AND gm.user_id = $1
       JOIN users payer ON payer.id = s.paid_by
       JOIN users recipient ON recipient.id = s.paid_to
       ORDER BY s.created_at DESC${unlimited ? '' : ' LIMIT 100'}`,
      [userId],
    );
    const transactions = [...result.rows, ...activity.rows]
      .concat(settlements.rows, friendSettlements.rows)
      .sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt))
      .slice(0, unlimited ? undefined : 100);
    return transactions;
  }

  const activityResult = await query(
    `SELECT a.id AS "_id", a.group_id AS "groupId", a.activity_type AS "activityType",
            'ACTIVITY' AS type, a.description, a.details, a.amount::text AS "totalAmount",
            a.currency, a.created_at AS "createdAt", a.actor_id AS "paidBy",
            actor.username AS "paidByUsername", actor.fullnamae AS "paidByName",
            ARRAY[]::text[] AS "participantIds", '[]'::json AS splits, '[]'::json AS items
     FROM group_activity a
     JOIN groups g ON g.id = a.group_id AND NOT g.is_personal${includeFriendLedger ? '' : ' AND NOT g.is_friend_ledger'}
     JOIN users actor ON actor.id = a.actor_id
     WHERE a.group_id = $1`,
    [groupId],
  );
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
  const friendSettlements = await query(
    `SELECT a.id AS "_id", a.group_id AS "groupId",
            'Settlement to ' || recipient.fullnamae AS description,
            a.amount::text AS "totalAmount", a.currency, 'SETTLEMENT' AS type,
            'Settlement' AS category, NULL::text AS subcategory,
            'SETTLEMENT' AS "splitStrategy", s.paid_by AS "paidBy",
            s.created_at AS "createdAt", s.note,
            NULL::text AS "paymentProofUrl",
            payer.username AS "paidByUsername", payer.fullnamae AS "paidByName",
            ARRAY[s.paid_by::text, s.paid_to::text] AS "participantIds",
            '[]'::json AS items, s.paid_to AS "paidTo",
            recipient.username AS "paidToUsername", recipient.fullnamae AS "paidToName",
            '[]'::json AS splits
     FROM friend_settlement_allocations a
     JOIN friend_settlements s ON s.id = a.settlement_id
     JOIN groups g ON g.id = a.group_id AND NOT g.is_friend_ledger
     JOIN users payer ON payer.id = s.paid_by
     JOIN users recipient ON recipient.id = s.paid_to
     WHERE a.group_id = $1`,
    [groupId],
  );
  const transactions = [...result.rows, ...settlements.rows, ...friendSettlements.rows, ...activityResult.rows]
    .sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt))
    .slice(0, unlimited ? undefined : 100);
  return transactions;
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
    `SELECT e.group_id AS "groupId", g.is_personal AS "isPersonal",
            g.is_friend_ledger AS "isFriendLedger"
     FROM expenses e JOIN groups g ON g.id = e.group_id
     WHERE e.id = $1 AND e.type <> 'SETTLEMENT'`,
    [expenseId],
  );
  if (!expense.rowCount) throw Object.assign(new Error('Expense not found'), { statusCode: 404 });
  if (expense.rows[0].isFriendLedger) {
    const friendship = await client.query(
      `SELECT 1 FROM friend_ledgers fl
       JOIN friendships f ON f.user_low = fl.user_low AND f.user_high = fl.user_high
       WHERE fl.group_id = $1 AND (fl.user_low = $2 OR fl.user_high = $2)
       FOR UPDATE OF f`,
      [expense.rows[0].groupId, userId],
    );
    if (!friendship.rowCount) throw Object.assign(new Error('Friend not found'), { statusCode: 404 });
  }
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
  if (!expense.rows[0].isPersonal) {
    await recordGroupActivity(client, {
      groupId: expense.rows[0].groupId,
      expenseId,
      actorId: userId,
      activityType: 'COMMENT_ADDED',
      description: `Comment added to an expense`,
      details: `${author.rows[0].authorName || 'A group member'} commented: “${content.trim().slice(0, 180)}”`,
    });
  }
  return { ...result.rows[0], authorName: author.rows[0].authorName };
});

export const deleteExpenseComment = async ({ commentId, userId }) => withTransaction(async (client) => {
  const comment = await client.query(
    `SELECT ec.expense_id AS "expenseId", e.group_id AS "groupId", e.description,
            author.fullnamae AS "authorName", g.is_personal AS "isPersonal",
            g.is_friend_ledger AS "isFriendLedger"
     FROM expense_comments ec
     JOIN expenses e ON e.id = ec.expense_id
     JOIN groups g ON g.id = e.group_id
     JOIN users author ON author.id = ec.user_id
     JOIN group_members gm ON gm.group_id = e.group_id AND gm.user_id = $2
     WHERE ec.id = $1 AND ec.user_id = $2`,
    [commentId, userId],
  );
  if (!comment.rowCount) throw Object.assign(new Error('Comment not found or you cannot delete it'), { statusCode: 404 });
  if (comment.rows[0].isFriendLedger) {
    const friendship = await client.query(
      `SELECT 1 FROM friend_ledgers fl
       JOIN friendships f ON f.user_low = fl.user_low AND f.user_high = fl.user_high
       WHERE fl.group_id = $1 AND (fl.user_low = $2 OR fl.user_high = $2)
       FOR UPDATE OF f`,
      [comment.rows[0].groupId, userId],
    );
    if (!friendship.rowCount) throw Object.assign(new Error('Comment not found or you cannot delete it'), { statusCode: 404 });
  }
  const result = await client.query(
    `DELETE FROM expense_comments ec
     USING expenses e, group_members gm
     WHERE ec.id = $1 AND ec.user_id = $2
       AND e.id = ec.expense_id AND gm.group_id = e.group_id AND gm.user_id = $2
     RETURNING ec.id AS "_id"`,
    [commentId, userId],
  );
  if (!result.rowCount) throw Object.assign(new Error('Comment not found or you cannot delete it'), { statusCode: 404 });
  if (!comment.rows[0].isPersonal) {
    await recordGroupActivity(client, {
      groupId: comment.rows[0].groupId,
      expenseId: comment.rows[0].expenseId,
      actorId: userId,
      activityType: 'COMMENT_DELETED',
      description: `Comment removed from “${comment.rows[0].description}”`,
      details: `${comment.rows[0].authorName || 'A group member'} deleted a comment from “${comment.rows[0].description}”.`,
    });
  }
  return { _id: result.rows[0]._id, deleted: true };
});

const calculateExpenseShares = ({
  paidBy, totalAmount, splitStrategy, participants, values, items = [],
  description, currency, category, subcategory, note,
}) => {
  const invalid = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  if (typeof description !== 'string' || !description.trim()) invalid('Expense description is required');
  if (!Number.isFinite(Number(totalAmount)) || Number(totalAmount) <= 0) invalid('Expense amount must be greater than zero');
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) invalid('Enter a valid three-letter expense currency code');
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
    // Store each debt against a sorted user pair; direction and multiplier encode its signed change.
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
  friendId = null,
  actorId,
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
  actorId = actorId || paidBy;
  const originalAmount = String(totalAmount);
  const originalCurrency = currency;
  let conversionRate = 1;
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
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw Object.assign(new Error('Enter a valid three-letter expense currency code'), { statusCode: 400 });
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

  const entitlementResult = await query(
    `SELECT u.plan, u.premium_until AS "premiumUntil", s.settings
       FROM users u CROSS JOIN platform_settings s WHERE u.id = $1`,
    [actorId],
  );
  if (!entitlementResult.rowCount) throw Object.assign(new Error('User not found'), { statusCode: 401 });
  const entitlement = entitlementResult.rows[0];
  const isPremium = entitlement.plan === 'premium'
    && (!entitlement.premiumUntil || new Date(entitlement.premiumUntil) > new Date());
  const settings = entitlement.settings || {};
  const conversionEnabled = isFeatureEnabled(settings, isPremium, 'currencyConversion');

  if (groupId) {
    const groupResult = await query(
      `SELECT currency, is_personal AS "isPersonal", is_friend_ledger AS "isFriendLedger"
       FROM groups WHERE id = $1`,
      [groupId],
    );
    if (!groupResult.rowCount) throw Object.assign(new Error('Group not found'), { statusCode: 404 });
    const group = groupResult.rows[0];
    if (!group.isPersonal && !group.isFriendLedger) {
      await normalizeGroupBalances(groupId, actorId);
      const groupCurrency = group.currency || 'INR';
      if (currency !== groupCurrency && !conversionEnabled) {
        throw Object.assign(new Error('Group currency conversion is a Premium feature. Upgrade to Premium or ask an admin to enable it for free users.'), { statusCode: 402 });
      }
      conversionRate = await getExchangeRate(currency, groupCurrency);
      if (splitStrategy === 'ITEMIZED') {
        items = items.map((item) => ({ ...item, amount: convertMoney(item.amount, conversionRate) }));
        totalAmount = sumAmounts(items.map((item) => item.amount));
      } else if (['EXACT', 'REIMBURSEMENT'].includes(splitStrategy)) {
        values = convertSplitValues(values, splitStrategy, conversionRate);
        totalAmount = sumAmounts(values);
      } else {
        totalAmount = convertMoney(totalAmount, conversionRate);
        values = convertSplitValues(values, splitStrategy, conversionRate);
      }
      if (new Decimal(totalAmount).lte(0)) {
        throw Object.assign(new Error('The converted expense is below the smallest supported amount'), { statusCode: 400 });
      }
      currency = groupCurrency;
    }
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
  if (!isPersonal) {
    const membership = await query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, actorId],
    );
    if (!membership.rowCount) {
      throw Object.assign(new Error('Only group members can add an expense'), { statusCode: 403 });
    }
  }
  if (isPersonal) groupId = (await ensurePersonalExpenseGroup(paidBy))._id;
  const expense = await withTransaction(async (client) => {
    const account = await client.query(
      `SELECT plan, premium_until AS "premiumUntil" FROM users WHERE id = $1 FOR UPDATE`,
      [actorId],
    );
    const currentPremium = account.rows[0]?.plan === 'premium'
      && (!account.rows[0].premiumUntil || new Date(account.rows[0].premiumUntil) > new Date());
    const dailyLimit = currentPremium ? settings.limits?.premiumDailyExpenses : settings.limits?.freeDailyExpenses;
    if (dailyLimit != null) {
      const usage = await client.query(
        `SELECT COUNT(*)::integer AS count FROM expenses
          WHERE paid_by = $1 AND created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'`,
        [actorId],
      );
      if (usage.rows[0].count >= dailyLimit) {
        throw Object.assign(new Error(`Your ${currentPremium ? 'premium' : 'free'} plan allows ${dailyLimit} expenses per day`), { statusCode: 429 });
      }
    }
    if (!isPersonal) {
      const group = await client.query(
        'SELECT is_friend_ledger AS "isFriendLedger" FROM groups WHERE id = $1 FOR SHARE',
        [groupId],
      );
      if (!group.rowCount) throw Object.assign(new Error('Group not found'), { statusCode: 404 });
      if (group.rows[0].isFriendLedger) {
        if (!friendId) {
          throw Object.assign(new Error('Use the friend history page to add an expense to this private ledger'), { statusCode: 404 });
        }
        const friendship = await client.query(
          `SELECT 1 FROM friend_ledgers fl
           JOIN friendships f ON f.user_low = fl.user_low AND f.user_high = fl.user_high
           WHERE fl.group_id = $1
             AND fl.user_low = LEAST($2::uuid, $3::uuid)
             AND fl.user_high = GREATEST($2::uuid, $3::uuid)
             AND ($2 = fl.user_low OR $2 = fl.user_high)
           FOR UPDATE OF f`,
          [groupId, actorId, friendId],
        );
        if (!friendship.rowCount) throw Object.assign(new Error('Friend not found'), { statusCode: 404 });
      } else if (friendId) {
        throw Object.assign(new Error('This expense is not in the selected friend ledger'), { statusCode: 404 });
      }
      const allowed = await client.query(
        'SELECT user_id FROM group_members WHERE group_id = $1 AND user_id = ANY($2::uuid[])',
        [groupId, [...new Set([actorId, paidBy, ...participants])]],
      );
      if (allowed.rowCount !== new Set([actorId, paidBy, ...participants]).size) {
        throw Object.assign(new Error('Actor, payer and participants must belong to the group'), { statusCode: 400 });
      }
    }
    const proofUrl = proofBuffer
      ? await uploadImageBuffer(proofBuffer, 'splitcare/expense-proofs')
      : null;
    const created = await client.query(
      `INSERT INTO expenses
         (group_id, description, total_amount, currency, split_strategy, paid_by, type, category,
          subcategory, note, payment_proof_url, original_amount, original_currency, conversion_rate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id AS "_id", group_id AS "groupId", description, total_amount::text AS "totalAmount",
                 currency, type, split_strategy AS "splitStrategy", paid_by AS "paidBy",
                 category, subcategory, created_at AS "createdAt", note, payment_proof_url AS "paymentProofUrl",
                 original_amount::text AS "originalAmount", original_currency AS "originalCurrency",
                 conversion_rate::text AS "conversionRate"`,
      [groupId, description.trim(), totalAmount, currency, splitStrategy, paidBy, type, category,
        subcategory?.trim() || null, note?.trim() || null, proofUrl, originalAmount, originalCurrency, conversionRate],
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
    const actor = await client.query('SELECT fullnamae FROM users WHERE id = $1', [actorId]);
    await recordGroupActivity(client, {
      groupId,
      expenseId: row._id,
      actorId,
      activityType: 'EXPENSE_ADDED',
      description: `Expense added: ${description.trim()}`,
      details: `${actor.rows[0]?.fullnamae || 'A group member'} added ${originalCurrency} ${new Decimal(originalAmount).toFixed(2)} for “${description.trim()}”${originalCurrency === currency ? '' : ` (converted to ${currency} ${new Decimal(totalAmount).toFixed(2)})`}.`,
      amount: totalAmount,
      currency,
    });
    return row;
  });
  eventEmitter.emit(EVENTS.EXPENSE_CREATED, expense);
  return {
    ...expense,
    originalAmount,
    originalCurrency,
    conversionRate,
  };
};

export const updateExpense = async ({
  expenseId,
  editorId,
  friendId = null,
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
  const originalAmount = String(totalAmount);
  const originalCurrency = currency;
  let conversionRate = 1;
  const expenseContext = await query(
    `SELECT e.group_id AS "groupId", g.currency AS "groupCurrency",
            g.is_personal AS "isPersonal", g.is_friend_ledger AS "isFriendLedger"
     FROM expenses e
     JOIN groups g ON g.id = e.group_id
     JOIN group_members gm ON gm.group_id = e.group_id AND gm.user_id = $2
     WHERE e.id = $1`,
    [expenseId, editorId],
  );
  if (!expenseContext.rowCount) throw Object.assign(new Error('Expense not found or you cannot edit it'), { statusCode: 404 });
  const context = expenseContext.rows[0];
  if (!context.isPersonal && !context.isFriendLedger) {
    await normalizeGroupBalances(context.groupId, editorId);
    const groupCurrency = context.groupCurrency || 'INR';
    if (currency !== groupCurrency
      && !(await getUserFeatureAccess(editorId)).features.currencyConversion) {
      throw Object.assign(new Error('Group currency conversion is a Premium feature. Upgrade to Premium or ask an admin to enable it for free users.'), { statusCode: 402 });
    }
    conversionRate = await getExchangeRate(currency, groupCurrency);
    if (splitStrategy === 'ITEMIZED') {
      items = items.map((item) => ({ ...item, amount: convertMoney(item.amount, conversionRate) }));
      totalAmount = sumAmounts(items.map((item) => item.amount));
    } else if (['EXACT', 'REIMBURSEMENT'].includes(splitStrategy)) {
      values = convertSplitValues(values, splitStrategy, conversionRate);
      totalAmount = sumAmounts(values);
    } else {
      totalAmount = convertMoney(totalAmount, conversionRate);
      values = convertSplitValues(values, splitStrategy, conversionRate);
    }
    if (new Decimal(totalAmount).lte(0)) {
      throw Object.assign(new Error('The converted expense is below the smallest supported amount'), { statusCode: 400 });
    }
    currency = groupCurrency;
  }
  const { splits, itemSplits } = calculateExpenseShares({
    paidBy, totalAmount, splitStrategy, participants, values, items,
    description, currency, category, subcategory, note,
  });
  const updated = await withTransaction(async (client) => {
    const existingResult = await client.query(
      `SELECT e.id AS "_id", e.group_id AS "groupId", e.paid_by AS "paidBy",
              e.description, e.total_amount::text AS "totalAmount",
              e.currency, e.type, e.payment_proof_url AS "paymentProofUrl",
              g.currency AS "groupCurrency",
              g.name AS "groupName", g.is_personal AS "isPersonal",
              g.is_friend_ledger AS "isFriendLedger",
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
    if (existing.isFriendLedger) {
      if (!friendId) {
        throw Object.assign(new Error('Use the friend history page to edit this private ledger expense'), { statusCode: 404 });
      }
      const friendship = await client.query(
        `SELECT 1 FROM friend_ledgers fl
         JOIN friendships f ON f.user_low = fl.user_low AND f.user_high = fl.user_high
         WHERE fl.group_id = $1
           AND fl.user_low = LEAST($2::uuid, $3::uuid)
           AND fl.user_high = GREATEST($2::uuid, $3::uuid)
           AND ($2 = fl.user_low OR $2 = fl.user_high)
         FOR UPDATE OF f`,
        [existing.groupId, editorId, friendId],
      );
      if (!friendship.rowCount) throw Object.assign(new Error('Friend not found'), { statusCode: 404 });
    } else if (friendId) {
      throw Object.assign(new Error('This expense is not in the selected friend ledger'), { statusCode: 404 });
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
    const previousCurrency = !existing.isPersonal && !existing.isFriendLedger
      ? existing.groupCurrency || 'INR'
      : existing.currency;
    if (existing.currency !== previousCurrency) {
      const previousRate = await getExchangeRate(existing.currency, previousCurrency);
      previousSplits.forEach((split) => {
        split.amountOwed = split.amountOwed.mul(previousRate).toDecimalPlaces(2);
      });
    }
    // Remove the old expense's effect before applying its replacement, in the same transaction.
    await applyGroupBalances(client, {
      groupId: existing.groupId,
      paidBy: existing.paidBy,
      currency: previousCurrency,
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
           note = $9, payment_proof_url = $10, original_amount = $11,
           original_currency = $12, conversion_rate = $13
       WHERE id = $14`,
      [description.trim(), totalAmount, currency, splitStrategy, paidBy,
        splitStrategy === 'REIMBURSEMENT' ? 'REIMBURSEMENT' : 'EXPENSE',
        category, subcategory?.trim() || null, note?.trim() || null, proofUrl,
        originalAmount, originalCurrency, conversionRate, expenseId],
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
    const previousTotal = new Decimal(existing.totalAmount);
    await recordGroupActivity(client, {
      groupId: existing.groupId,
      expenseId,
      actorId: editorId,
      activityType: 'EXPENSE_UPDATED',
      description: `Expense updated: ${description.trim()}`,
      details: `${editor.rows[0]?.fullnamae || 'A group member'} updated “${existing.description}” to “${description.trim()}” (${existing.currency} ${previousTotal.toFixed(2)} → ${originalCurrency} ${new Decimal(originalAmount).toFixed(2)}${originalCurrency === currency ? '' : ` converted to ${currency} ${new Decimal(totalAmount).toFixed(2)}`}).`,
      amount: totalAmount,
      currency,
    });
    return {
      _id: expenseId,
      groupId: existing.groupId,
      description: description.trim(),
      totalAmount: String(totalAmount),
      currency,
      originalAmount,
      originalCurrency,
      conversionRate,
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

export const deleteExpense = async ({ expenseId, userId, friendId = null }) => {
  const expenseContext = await query(
    `SELECT e.group_id AS "groupId", g.is_personal AS "isPersonal",
            g.is_friend_ledger AS "isFriendLedger"
     FROM expenses e
     JOIN groups g ON g.id = e.group_id
     JOIN group_members gm ON gm.group_id = e.group_id AND gm.user_id = $2
     WHERE e.id = $1`,
    [expenseId, userId],
  );
  if (!expenseContext.rowCount) throw Object.assign(new Error('Expense not found or you cannot delete it'), { statusCode: 404 });
  if (!expenseContext.rows[0].isPersonal && !expenseContext.rows[0].isFriendLedger) {
    await normalizeGroupBalances(expenseContext.rows[0].groupId, userId);
  }
  const deleted = await withTransaction(async (client) => {
    const result = await client.query(
      `SELECT e.id AS "_id", e.group_id AS "groupId", e.description,
              e.total_amount::text AS "totalAmount", e.currency, e.type,
              e.paid_by AS "paidBy", e.payment_proof_url AS "paymentProofUrl",
              g.name AS "groupName", g.currency AS "groupCurrency",
              g.is_personal AS "isPersonal",
              g.is_friend_ledger AS "isFriendLedger",
              COALESCE((SELECT json_agg(json_build_object(
                'userId', es.user_id::text,
                'amountOwed', es.amount_owed::text
              ) ORDER BY es.user_id) FROM expense_splits es WHERE es.expense_id = e.id), '[]'::json) AS splits
       FROM expenses e JOIN groups g ON g.id = e.group_id
       WHERE e.id = $1 AND e.type <> 'SETTLEMENT'
       FOR UPDATE OF e`,
      [expenseId],
    );
    const expense = result.rows[0];
    if (!expense) throw Object.assign(new Error('Expense not found'), { statusCode: 404 });
    const membership = await client.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [expense.groupId, userId],
    );
    if (!membership.rowCount) throw Object.assign(new Error('Only group members can delete this expense'), { statusCode: 403 });
    if (expense.isFriendLedger) {
      if (!friendId) {
        throw Object.assign(new Error('Use the friend history page to delete this private ledger expense'), { statusCode: 404 });
      }
      const friendship = await client.query(
        `SELECT 1 FROM friend_ledgers fl
         JOIN friendships f ON f.user_low = fl.user_low AND f.user_high = fl.user_high
         WHERE fl.group_id = $1
           AND fl.user_low = LEAST($2::uuid, $3::uuid)
           AND fl.user_high = GREATEST($2::uuid, $3::uuid)
           AND ($2 = fl.user_low OR $2 = fl.user_high)
         FOR UPDATE OF f`,
        [expense.groupId, userId, friendId],
      );
      if (!friendship.rowCount) throw Object.assign(new Error('Friend not found'), { statusCode: 404 });
    } else if (friendId) {
      throw Object.assign(new Error('This expense is not in the selected friend ledger'), { statusCode: 404 });
    }
    if (expense.isPersonal && expense.paidBy !== userId) {
      throw Object.assign(new Error('Only the account owner can delete a personal expense'), { statusCode: 403 });
    }
    if (!expense.isPersonal) {
      const participantIds = [...new Set([expense.paidBy, ...expense.splits.map((split) => split.userId)])];
      const currentMembers = await client.query(
        'SELECT user_id FROM group_members WHERE group_id = $1 AND user_id = ANY($2::uuid[])',
        [expense.groupId, participantIds],
      );
      if (currentMembers.rowCount !== participantIds.length) {
        throw Object.assign(new Error('This expense includes a member who has left the group and cannot be safely deleted.'), { statusCode: 409 });
      }
    }

    const balanceCurrency = !expense.isPersonal && !expense.isFriendLedger
      ? expense.groupCurrency || 'INR'
      : expense.currency;
    const balanceSplits = expense.splits.map((split) => ({
      userId: split.userId,
      amountOwed: new Decimal(split.amountOwed),
    }));
    if (expense.currency !== balanceCurrency) {
      const rate = await getExchangeRate(expense.currency, balanceCurrency);
      balanceSplits.forEach((split) => {
        split.amountOwed = split.amountOwed.mul(rate).toDecimalPlaces(2);
      });
    }
    await applyGroupBalances(client, {
      groupId: expense.groupId,
      paidBy: expense.paidBy,
      currency: balanceCurrency,
      splits: balanceSplits,
      multiplier: -1,
    });
    const actor = await client.query('SELECT fullnamae FROM users WHERE id = $1', [userId]);
    await recordGroupActivity(client, {
      groupId: expense.groupId,
      actorId: userId,
      activityType: 'EXPENSE_DELETED',
      description: `Expense deleted: ${expense.description}`,
      details: `${actor.rows[0]?.fullnamae || 'A group member'} deleted “${expense.description}” (${expense.currency} ${new Decimal(expense.totalAmount).toFixed(2)}). Group balances were adjusted.`,
      amount: expense.totalAmount,
      currency: expense.currency,
    });
    await client.query('DELETE FROM expenses WHERE id = $1', [expenseId]);
    return expense;
  });

  let warning;
  if (deleted.paymentProofUrl) {
    try {
      await deleteImageByUrl(deleted.paymentProofUrl);
    } catch (error) {
      console.error('Expense deleted, but its payment proof could not be deleted:', error);
      warning = 'Expense deleted, but its payment proof could not be deleted.';
    }
  }
  return { _id: deleted._id, groupId: deleted.groupId, deleted: true, warning };
};
