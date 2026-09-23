import Balance from '../models/Balance.js';
import { decimalValue } from '../utils/decimal.js';

export const simplifyDebts = async (groupId) => {
  const balances = await Balance.find({ groupId }).select('user1 user2 netOwed').lean();
  const net = new Map();
  const add = (user, amount) => net.set(user, (net.get(user) || decimalValue(0)).plus(amount));
  for (const balance of balances) {
    const amount = decimalValue(balance.netOwed);
    add(balance.user1.toString(), amount);
    add(balance.user2.toString(), amount.negated());
  }
  const creditors = [...net].filter(([, amount]) => amount.gt(0)).sort((a, b) => b[1].cmp(a[1]));
  const debtors = [...net].filter(([, amount]) => amount.lt(0)).sort((a, b) => a[1].cmp(b[1]));
  const transactions = [];
  let debtorIndex = 0;
  let creditorIndex = 0;
  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const [from, debt] = debtors[debtorIndex];
    const [to, credit] = creditors[creditorIndex];
    const amount = DecimalMin(debt.negated(), credit);
    transactions.push({ from, to, amount: amount.toFixed(2) });
    debtors[debtorIndex][1] = debt.plus(amount);
    creditors[creditorIndex][1] = credit.minus(amount);
    if (debtors[debtorIndex][1].eq(0)) debtorIndex += 1;
    if (creditors[creditorIndex][1].eq(0)) creditorIndex += 1;
  }
  return transactions;
};

const DecimalMin = (left, right) => (left.lte(right) ? left : right);