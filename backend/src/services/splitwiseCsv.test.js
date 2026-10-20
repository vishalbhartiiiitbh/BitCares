import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allocateSplitwiseExpense,
  parseSplitwiseCsv,
  splitwisePaymentBalanceDelta,
  validateSplitwiseMemberMappings,
} from './splitwiseCsv.js';

test('parses Splitwise expense, payment, quoted text, and total balance rows', () => {
  const csv = [
    'Date,Description,Category,Cost,Currency,Alice,Bob',
    '2026-01-02,"Dinner, ""special""",Dining out,20.00,INR,10.00,-10.00',
    '2026-01-03,Alice paid Bob,Payment,5.00,INR,5.00,-5.00',
    '2026-01-03,Total balance,,,"INR",15.00,-15.00',
  ].join('\r\n');
  const parsed = parseSplitwiseCsv(csv);

  assert.deepEqual(parsed.memberNames, ['Alice', 'Bob']);
  assert.equal(parsed.transactions.length, 2);
  assert.equal(parsed.transactions[0].description, 'Dinner, "special"');
  assert.equal(parsed.transactions[0].costCents, 2000);
  assert.equal(parsed.transactions[1].isPayment, true);
  assert.equal(parsed.summaryRows, 1);
});

test('reports invalid transaction balances with the source row number', () => {
  const csv = [
    'Date,Description,Category,Cost,Currency,Alice,Bob',
    '2026-01-02,Dinner,General,20.00,INR,10.00,-9.00',
  ].join('\n');

  assert.throws(() => parseSplitwiseCsv(csv), /Row 2: member balances must add up to zero/);
});

test('rejects payment rows that do not identify one payer and one recipient', () => {
  const csv = [
    'Date,Description,Category,Cost,Currency,Alice,Bob,Casey',
    '2026-01-02,Payment,Payment,20.00,INR,20.00,-10.00,-10.00',
  ].join('\n');

  assert.throws(() => parseSplitwiseCsv(csv), /Row 2: a payment must show one payer and one recipient/);
});

test('reconstructs multiple-payer expense entries without changing member net balances', () => {
  const sourceBalances = [
    { userId: 'alice', cents: 6600 },
    { userId: 'bob', cents: -1400 },
    { userId: 'casey', cents: 1600 },
    { userId: 'drew', cents: -3400 },
    { userId: 'erin', cents: -3400 },
  ];
  const allocations = allocateSplitwiseExpense({ rowNumber: 7, costCents: 17000 }, sourceBalances);
  const netByUser = new Map(sourceBalances.map(({ userId }) => [userId, 0]));
  let totalCost = 0;

  allocations.forEach((expense) => {
    totalCost += expense.cents;
    netByUser.set(expense.userId, netByUser.get(expense.userId) + expense.cents);
    expense.splits.forEach((split) => {
      netByUser.set(split.userId, netByUser.get(split.userId) - split.cents);
    });
  });

  assert.equal(totalCost, 17000);
  sourceBalances.forEach(({ userId, cents }) => assert.equal(netByUser.get(userId), cents));
});

test('assigns the remainder of a single-payer expense to the payer', () => {
  const allocations = allocateSplitwiseExpense(
    { rowNumber: 8, costCents: 10000 },
    [
      { userId: 'alice', cents: 7000 },
      { userId: 'bob', cents: -5000 },
      { userId: 'casey', cents: -2000 },
    ],
  );

  assert.deepEqual(allocations, [{
    userId: 'alice',
    cents: 10000,
    splits: [
      { userId: 'alice', cents: 3000 },
      { userId: 'bob', cents: 5000 },
      { userId: 'casey', cents: 2000 },
    ],
  }]);
});

test('applies payment balance deltas in the direction that reduces the payer debt', () => {
  assert.equal(splitwisePaymentBalanceDelta('a-member', 'z-member', 32600), 32600);
  assert.equal(splitwisePaymentBalanceDelta('z-member', 'a-member', 32600), -32600);
});

test('requires a distinct valid Splitpayerly account for each CSV member', () => {
  const memberNames = ['Alice', 'Bob'];
  const aliceId = '33f3c393-1ca0-4a9c-9429-744831920e31';
  const bobId = 'cb4be5f4-1d61-46f1-a112-fca5dc790d27';

  assert.deepEqual(
    validateSplitwiseMemberMappings(memberNames, { Alice: aliceId, Bob: bobId }),
    [aliceId, bobId],
  );
  assert.throws(
    () => validateSplitwiseMemberMappings(memberNames, { Alice: aliceId, Bob: aliceId }),
    /Each Splitwise member must map to a different Splitpayerly group member/,
  );
  assert.throws(
    () => validateSplitwiseMemberMappings(memberNames, { Alice: aliceId }),
    /Choose a Splitpayerly group member for "Bob"/,
  );
});

test('reconstructs member balance changes for expenses and payments in either ID order', () => {
  const parsed = parseSplitwiseCsv([
    'Date,Description,Category,Cost,Currency,Alice,Bob',
    '2026-01-01,Dinner,General,100.00,INR,100.00,-100.00',
    '2026-01-02,Alice paid Bob,Payment,50.00,INR,50.00,-50.00',
    '2026-01-03,Bob paid Alice,Payment,20.00,INR,-20.00,20.00',
  ].join('\n'));
  const expected = new Map(parsed.memberNames.map((_, index) => [`member-${index}`, 0]));
  const actual = new Map(expected);

  parsed.transactions.forEach((transaction) => {
    const balances = transaction.balances.map((balance, index) => {
      const userId = `member-${index}`;
      expected.set(userId, expected.get(userId) + balance.cents);
      return { userId, cents: balance.cents };
    });

    if (transaction.isPayment) {
      const payer = balances.find((balance) => balance.cents > 0);
      const payee = balances.find((balance) => balance.cents < 0);
      const [user1, user2] = [payer.userId, payee.userId].sort();
      const delta = splitwisePaymentBalanceDelta(payer.userId, payee.userId, transaction.costCents);
      actual.set(user1, actual.get(user1) + delta);
      actual.set(user2, actual.get(user2) - delta);
      return;
    }

    allocateSplitwiseExpense(transaction, balances).forEach((expense) => {
      expense.splits.forEach((split) => {
        if (split.userId === expense.userId) return;
        const [user1, user2] = [expense.userId, split.userId].sort();
        const delta = expense.userId === user1 ? split.cents : -split.cents;
        actual.set(user1, actual.get(user1) + delta);
        actual.set(user2, actual.get(user2) - delta);
      });
    });
  });

  assert.deepEqual(actual, expected);
});
