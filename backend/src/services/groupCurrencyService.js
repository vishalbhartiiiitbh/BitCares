import Decimal from 'decimal.js';
import { query, withTransaction } from '../db/index.js';
import { getExchangeRate } from './exchangeRateService.js';

export const getGroupCurrency = async (groupId) => {
  const result = await query('SELECT currency FROM groups WHERE id = $1', [groupId]);
  if (!result.rowCount) throw Object.assign(new Error('Group not found'), { statusCode: 404 });
  return result.rows[0].currency || 'INR';
};

export const normalizeGroupBalancesInTransaction = async (client, groupId, userId) => {
  const groupResult = await client.query(
    `SELECT g.currency, g.is_personal AS "isPersonal", g.is_friend_ledger AS "isFriendLedger"
     FROM groups g
     JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $2
     WHERE g.id = $1
     FOR UPDATE OF g`,
    [groupId, userId],
  );
  if (!groupResult.rowCount) {
    throw Object.assign(new Error('Group or membership not found'), { statusCode: 404 });
  }
  const group = groupResult.rows[0];
  const baseCurrency = group.currency || 'INR';
  if (group.isPersonal || group.isFriendLedger) return baseCurrency;

  const balances = await client.query(
    `SELECT user1, user2, currency, net_owed::text AS amount
     FROM balances WHERE group_id = $1`,
    [groupId],
  );
  const legacyExpenses = await client.query(
    `SELECT id, currency, total_amount::text AS "totalAmount",
            split_strategy AS "splitStrategy"
     FROM expenses
     WHERE group_id = $1 AND currency <> $2 AND type <> 'SETTLEMENT'`,
    [groupId, baseCurrency],
  );
  const currencies = new Set([
    ...balances.rows.map((balance) => balance.currency),
    ...legacyExpenses.rows.map((expense) => expense.currency),
  ]);
  if ([...currencies].every((currency) => currency === baseCurrency)) return baseCurrency;

  const rates = new Map(await Promise.all([...currencies].map(async (currency) => ([
    currency,
    await getExchangeRate(currency, baseCurrency),
  ]))));
  const legacyExpenseIds = legacyExpenses.rows.map((expense) => expense.id);
  const legacyItems = legacyExpenseIds.length
    ? await client.query(
      'SELECT expense_id AS "expenseId", amount::text FROM expense_items WHERE expense_id = ANY($1::uuid[])',
      [legacyExpenseIds],
    )
    : { rows: [] };
  const ratesByExpenseId = new Map(legacyExpenses.rows.map((expense) => [
    expense.id,
    rates.get(expense.currency),
  ]));
  const expensesWithZeroItems = new Set(legacyItems.rows
    .filter((item) => new Decimal(item.amount).mul(ratesByExpenseId.get(item.expenseId)).toDecimalPlaces(2).lte(0))
    .map((item) => item.expenseId));
  for (const expense of legacyExpenses.rows) {
    const rate = rates.get(expense.currency);
    const convertedTotal = new Decimal(expense.totalAmount).mul(rate).toDecimalPlaces(2);
    if (convertedTotal.lte(0) || expensesWithZeroItems.has(expense.id)) {
      throw Object.assign(
        new Error('A legacy expense is below the smallest supported amount in the group currency and cannot be normalized safely'),
        { statusCode: 409 },
      );
    }
  }

  if (balances.rows.some((balance) => balance.currency !== baseCurrency)) {
    const normalized = new Map();
    for (const balance of balances.rows) {
      const key = `${balance.user1}:${balance.user2}`;
      const current = normalized.get(key) || new Decimal(0);
      normalized.set(
        key,
        current.plus(new Decimal(balance.amount).mul(rates.get(balance.currency)).toDecimalPlaces(2)),
      );
    }

    await client.query('DELETE FROM balances WHERE group_id = $1', [groupId]);
    for (const [key, amount] of normalized) {
      if (amount.isZero()) continue;
      const [user1, user2] = key.split(':');
      await client.query(
        `INSERT INTO balances (group_id, user1, user2, currency, net_owed)
         VALUES ($1, $2, $3, $4, $5)`,
        [groupId, user1, user2, baseCurrency, amount.toFixed(2)],
      );
    }
  }

  for (const expense of legacyExpenses.rows) {
    const rate = rates.get(expense.currency);
    await client.query(
      `UPDATE expense_splits es
       SET amount_owed = ROUND(es.amount_owed * $2::numeric, 2),
           split_value = CASE WHEN $3 <> ALL(ARRAY['PERCENTAGE', 'SHARES'])
             THEN ROUND(es.split_value * $2::numeric, 2)
             ELSE es.split_value END
       WHERE es.expense_id = $1`,
      [expense.id, rate, expense.splitStrategy],
    );
    await client.query(
      `UPDATE expense_items SET amount = ROUND(amount * $2::numeric, 2)
       WHERE expense_id = $1`,
      [expense.id, rate],
    );
    await client.query(
      `UPDATE expense_item_splits eis
       SET amount_owed = ROUND(eis.amount_owed * $2::numeric, 2)
       FROM expense_items ei
       WHERE eis.item_id = ei.id AND ei.expense_id = $1`,
      [expense.id, rate],
    );
    await client.query(
      `UPDATE expenses
       SET original_amount = COALESCE(original_amount, total_amount),
           original_currency = COALESCE(original_currency, currency),
           conversion_rate = $2,
           total_amount = ROUND(total_amount * $2::numeric, 2),
           currency = $3
       WHERE id = $1`,
      [expense.id, rate, baseCurrency],
    );
  }
  return baseCurrency;
};

export const normalizeGroupBalances = async (groupId, userId) => withTransaction(
  (client) => normalizeGroupBalancesInTransaction(client, groupId, userId),
);
