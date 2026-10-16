import Decimal from 'decimal.js';
import { query } from '../db/index.js';

export const simplifyDebts = async (groupId, userId) => {
  const membership = await query(
    `SELECT g.simplify_debts AS "simplifyDebts"
     FROM group_members gm JOIN groups g ON g.id = gm.group_id
     WHERE gm.group_id = $1 AND gm.user_id = $2 AND NOT g.is_friend_ledger`,
    [groupId, userId],
  );
  if (!membership.rowCount) throw Object.assign(new Error('Group or membership not found'), { statusCode: 404 });

  const result = await query(
    'SELECT user1, user2, currency, net_owed::text AS amount FROM balances WHERE group_id = $1',
    [groupId],
  );
  if (!membership.rows[0].simplifyDebts) {
    return result.rows
      .filter((row) => !new Decimal(row.amount).eq(0))
      .map((row) => {
        const amount = new Decimal(row.amount);
        return {
          from: amount.gt(0) ? row.user2 : row.user1,
          to: amount.gt(0) ? row.user1 : row.user2,
          amount: amount.abs().toFixed(2),
          currency: row.currency,
        };
      });
  }

  const netsByCurrency = new Map();
  for (const row of result.rows) {
    const net = netsByCurrency.get(row.currency) || new Map();
    net.set(row.user1, (net.get(row.user1) || new Decimal(0)).plus(row.amount));
    net.set(row.user2, (net.get(row.user2) || new Decimal(0)).minus(row.amount));
    netsByCurrency.set(row.currency, net);
  }

  const transactions = [];
  for (const [currency, net] of netsByCurrency) {
    const creditors = [...net].filter(([, amount]) => amount.gt(0)).sort((a, b) => b[1].cmp(a[1]));
    const debtors = [...net].filter(([, amount]) => amount.lt(0)).sort((a, b) => a[1].cmp(b[1]));
    let debtorIndex = 0;
    let creditorIndex = 0;
    while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
      const amount = Decimal.min(debtors[debtorIndex][1].negated(), creditors[creditorIndex][1]);
      transactions.push({
        from: debtors[debtorIndex][0],
        to: creditors[creditorIndex][0],
        amount: amount.toFixed(2),
        currency,
      });
      debtors[debtorIndex][1] = debtors[debtorIndex][1].plus(amount);
      creditors[creditorIndex][1] = creditors[creditorIndex][1].minus(amount);
      if (debtors[debtorIndex][1].eq(0)) debtorIndex += 1;
      if (creditors[creditorIndex][1].eq(0)) creditorIndex += 1;
    }
  }
  return transactions;
};
