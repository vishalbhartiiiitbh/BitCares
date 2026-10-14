import Decimal from 'decimal.js';
import { query } from '../db/index.js';

export const simplifyDebts = async (groupId, userId) => {
  const membership = await query(
    'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId],
  );
  if (!membership.rowCount) throw Object.assign(new Error('Group or membership not found'), { statusCode: 404 });

  const result = await query(
    'SELECT user1, user2, currency, net_owed::text AS amount FROM balances WHERE group_id = $1',
    [groupId],
  );
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
