import crypto from 'node:crypto';
import Decimal from 'decimal.js';
import { query, withTransaction } from '../db/index.js';
import { addExpense, listExpenses } from './expenseService.js';
import { getExchangeRate } from './exchangeRateService.js';
import { queueEmailNotification } from './emailNotificationService.js';

const validId = (id) => typeof id === 'string'
  && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
// Friend and balance rows use the same canonical ordering for either user's perspective.
const pairKey = (firstId, secondId) => [firstId, secondId].sort();
const currencies = ['INR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD'];

const assertFriends = async (client, firstId, secondId) => {
  if (!validId(firstId) || !validId(secondId) || firstId === secondId) {
    throw Object.assign(new Error('Choose a valid friend'), { statusCode: 400 });
  }
  const [lowId, highId] = pairKey(firstId, secondId);
  const result = await client.query(
    'SELECT 1 FROM friendships WHERE user_low = $1 AND user_high = $2 FOR UPDATE',
    [lowId, highId],
  );
  if (!result.rowCount) throw Object.assign(new Error('Friend not found'), { statusCode: 404 });
  return [lowId, highId];
};

const findFriendLedger = async (client, lowId, highId) => {
  const result = await client.query(
    `SELECT g.id AS "_id", g.name
     FROM friend_ledgers f JOIN groups g ON g.id = f.group_id
     WHERE f.user_low = $1 AND f.user_high = $2`,
    [lowId, highId],
  );
  return result.rows[0] || null;
};

const ensureFriendLedger = async (lowId, highId) => withTransaction(async (client) => {
  await assertFriends(client, lowId, highId);
  const existing = await findFriendLedger(client, lowId, highId);
  if (existing) return existing;
  const names = await client.query(
    'SELECT id, fullnamae, username FROM users WHERE id = ANY($1::uuid[])',
    [[lowId, highId]],
  );
  const nameById = new Map(names.rows.map((member) => [member.id, member.fullnamae || member.username]));
  const group = await client.query(
    `INSERT INTO groups (name, group_code, created_by, is_friend_ledger)
     VALUES ($1, $2, $3, TRUE)
     RETURNING id AS "_id", name`,
    [`${nameById.get(lowId)} and ${nameById.get(highId)}`, crypto.randomBytes(4).toString('hex').toUpperCase(), lowId],
  );
  await client.query(
    'INSERT INTO friend_ledgers (user_low, user_high, group_id) VALUES ($1,$2,$3)',
    [lowId, highId, group.rows[0]._id],
  );
  await client.query(
    'INSERT INTO group_members (group_id, user_id) VALUES ($1,$2), ($1,$3)',
    [group.rows[0]._id, lowId, highId],
  );
  return group.rows[0];
});

export const createFriendExpense = async ({ userId, friendId, expense }) => {
  const [lowId, highId] = pairKey(userId, friendId);
  const participants = expense.participants;
  if (!Array.isArray(participants) || participants.some((id) => id !== lowId && id !== highId)) {
    throw Object.assign(new Error('A direct friend expense can only include you and this friend'), { statusCode: 400 });
  }
  if (expense.paidBy !== lowId && expense.paidBy !== highId) {
    throw Object.assign(new Error('The payer must be you or this friend'), { statusCode: 400 });
  }
  const group = await ensureFriendLedger(lowId, highId);
  return addExpense({ ...expense, groupId: group._id, friendId, actorId: userId });
};

export const listFriendActivity = async (userId) => {
  const ledgers = await query(
    `SELECT f.user_low AS "userLow", f.user_high AS "userHigh",
            friend.id AS "friendId", friend.username AS "friendUsername",
            friend.fullnamae AS "friendName", fl.group_id AS "groupId"
     FROM friendships f
     JOIN users friend ON friend.id = CASE
       WHEN f.user_low = $1 THEN f.user_high ELSE f.user_low END
     LEFT JOIN friend_ledgers fl ON fl.user_low = f.user_low AND fl.user_high = f.user_high
     WHERE f.user_low = $1 OR f.user_high = $1
     ORDER BY friend.fullnamae, friend.username`,
    [userId],
  );
  const transactions = [];
  for (const ledger of ledgers.rows) {
    if (!ledger.groupId) continue;
    const activity = await listExpenses(ledger.groupId, userId, true, true);
    transactions.push(...activity.map((item) => ({
      ...item,
      groupName: `With ${ledger.friendName || ledger.friendUsername}`,
      friendId: ledger.friendId,
      friendName: ledger.friendName || ledger.friendUsername,
      isDirect: true,
    })));
  }

  const settlements = await query(
    `SELECT s.id AS "_id", s.paid_by AS "paidBy", s.paid_to AS "paidTo",
            payer.username AS "paidByUsername", payer.fullnamae AS "paidByName",
            recipient.username AS "paidToUsername", recipient.fullnamae AS "paidToName",
            s.amount::text AS "totalAmount", s.currency, s.note,
            s.created_at AS "createdAt",
            'FRIEND_SETTLEMENT' AS type, 'Settlement' AS category,
            'SETTLEMENT' AS "splitStrategy",
            ARRAY[s.paid_by::text, s.paid_to::text] AS "participantIds",
            COALESCE(json_agg(json_build_object(
              'groupId', a.group_id, 'groupName', g.name,
              'amount', a.amount::text, 'currency', a.currency,
              'exchangeRate', a.exchange_rate::text
            )) FILTER (WHERE a.id IS NOT NULL), '[]'::json) AS allocations,
            friend.id AS "friendId",
            friend.fullnamae AS "friendName",
            'With ' || COALESCE(friend.fullnamae, friend.username) AS "groupName",
            TRUE AS "isDirect"
     FROM friend_settlements s
     JOIN friendships f
       ON f.user_low = LEAST(s.paid_by, s.paid_to)
      AND f.user_high = GREATEST(s.paid_by, s.paid_to)
     JOIN users payer ON payer.id = s.paid_by
     JOIN users recipient ON recipient.id = s.paid_to
     JOIN users friend ON friend.id = CASE WHEN s.paid_by = $1 THEN s.paid_to ELSE s.paid_by END
     LEFT JOIN friend_settlement_allocations a ON a.settlement_id = s.id
     LEFT JOIN groups g ON g.id = a.group_id
     WHERE s.paid_by = $1 OR s.paid_to = $1
     GROUP BY s.id, payer.username, payer.fullnamae, recipient.username,
              recipient.fullnamae, friend.id, friend.fullnamae, friend.username
     ORDER BY s.created_at DESC`,
    [userId],
  );
  transactions.push(...settlements.rows.map((settlement) => ({
    ...settlement,
    description: `${settlement.paidByName} paid ${settlement.paidToName}`,
  })));
  return transactions.sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt));
};

export const getFriendHistory = async (userId, friendId) => {
  if (!validId(userId) || !validId(friendId) || userId === friendId) {
    throw Object.assign(new Error('Choose a valid friend'), { statusCode: 400 });
  }
  const [lowId, highId] = pairKey(userId, friendId);
  const friendResult = await query(
    `SELECT u.id AS "_id", u.username, u.fullnamae, u.email, u.coverimage
     FROM users u JOIN friendships f
       ON f.user_low = LEAST($1::uuid, $2::uuid)
      AND f.user_high = GREATEST($1::uuid, $2::uuid)
     WHERE u.id = $2`,
    [userId, friendId],
  );
  const friend = friendResult.rows[0];
  if (!friend) throw Object.assign(new Error('Friend not found'), { statusCode: 404 });
  const ownerCurrencyResult = await query(
    'SELECT default_currency AS "defaultCurrency" FROM users WHERE id = $1',
    [userId],
  );
  const defaultCurrency = ownerCurrencyResult.rows[0].defaultCurrency;
  const sharedGroups = await query(
    `SELECT g.id AS "groupId", g.name AS "groupName", g.created_at AS "createdAt"
     FROM groups g
     JOIN group_members own_member ON own_member.group_id = g.id AND own_member.user_id = $1
     JOIN group_members friend_member ON friend_member.group_id = g.id AND friend_member.user_id = $2
     WHERE NOT g.is_personal AND NOT g.is_friend_ledger
     ORDER BY g.name`,
    [userId, friendId],
  );
  const [lowUser, highUser] = pairKey(userId, friendId);
  const balancesResult = await query(
    `SELECT b.group_id AS "groupId", g.name AS "groupName", b.currency,
            b.net_owed::text AS amount, g.is_friend_ledger AS "isDirect"
     FROM balances b JOIN groups g ON g.id = b.group_id
     WHERE b.user1 = $1 AND b.user2 = $2 AND b.net_owed <> 0
       AND (
         g.is_friend_ledger
         OR EXISTS (
           SELECT 1 FROM group_members a
           JOIN group_members f ON f.group_id = a.group_id
           WHERE a.group_id = g.id AND a.user_id = $3 AND f.user_id = $4
         )
       )
     ORDER BY g.is_friend_ledger DESC, g.name, b.currency`,
    [lowUser, highUser, lowUser, highUser],
  );
  const directLedger = await findFriendLedger({ query }, lowId, highId);
  const allGroups = [...sharedGroups.rows];
  if (directLedger) allGroups.push({
    groupId: directLedger._id,
    groupName: 'Direct friend expenses',
    isDirect: true,
  });
  const balanceByGroup = new Map();
  for (const row of balancesResult.rows) {
    const signedAmount = userId === lowUser ? Number(row.amount) : -Number(row.amount);
    const groupBalances = balanceByGroup.get(row.groupId) || [];
    groupBalances.push({ currency: row.currency, netBalance: signedAmount.toFixed(2) });
    balanceByGroup.set(row.groupId, groupBalances);
  }
  const groups = allGroups.map((group) => ({
    ...group,
    balances: balanceByGroup.get(group.groupId) || [],
  }));
  const sharedGroupTransactions = [];
  for (const group of groups) {
    const activity = await listExpenses(group.groupId, userId, true, Boolean(group.isDirect));
    sharedGroupTransactions.push(...activity.map((item) => ({
      ...item,
      groupName: group.groupName,
      friendId,
      isDirect: Boolean(group.isDirect),
    })));
  }
  const settlements = await query(
    `SELECT s.id AS "_id", s.paid_by AS "paidBy", s.paid_to AS "paidTo",
            payer.fullnamae AS "paidByName", recipient.fullnamae AS "paidToName",
            s.amount::text AS "totalAmount", s.currency, s.note,
            s.created_at AS "createdAt",
            COALESCE(json_agg(json_build_object(
              'groupId', a.group_id, 'groupName', g.name,
              'amount', a.amount::text, 'currency', a.currency,
              'exchangeRate', a.exchange_rate::text
            )) FILTER (WHERE a.id IS NOT NULL), '[]'::json) AS allocations
     FROM friend_settlements s
     JOIN users payer ON payer.id = s.paid_by
     JOIN users recipient ON recipient.id = s.paid_to
     LEFT JOIN friend_settlement_allocations a ON a.settlement_id = s.id
     LEFT JOIN groups g ON g.id = a.group_id
     WHERE (s.paid_by = $1 AND s.paid_to = $2) OR (s.paid_by = $2 AND s.paid_to = $1)
     GROUP BY s.id, payer.fullnamae, recipient.fullnamae
     ORDER BY s.created_at DESC`,
    [userId, friendId],
  );
  const friendSettlements = settlements.rows.map((settlement) => ({
    ...settlement,
    description: `${settlement.paidByName} paid ${settlement.paidToName}`,
    friendId,
    type: 'FRIEND_SETTLEMENT',
    isDirect: true,
  }));

  const expenseTotalsByGroup = new Map();
  for (const transaction of sharedGroupTransactions) {
    if (['ACTIVITY', 'SETTLEMENT', 'FRIEND_SETTLEMENT'].includes(transaction.type)) continue;
    const totals = expenseTotalsByGroup.get(transaction.groupId) || new Map();
    totals.set(transaction.currency, (totals.get(transaction.currency) || new Decimal(0))
      .plus(transaction.totalAmount));
    expenseTotalsByGroup.set(transaction.groupId, totals);
  }
  const personalTransactions = sharedGroupTransactions.filter((transaction) => (
    transaction.isDirect && ['EXPENSE', 'REIMBURSEMENT'].includes(transaction.type)
  ));
  personalTransactions.push(...friendSettlements);
  const conversionRates = {};
  const currenciesToConvert = new Set(balancesResult.rows.map((row) => row.currency));
  for (const totals of expenseTotalsByGroup.values()) {
    for (const currency of totals.keys()) currenciesToConvert.add(currency);
  }
  for (const currency of currenciesToConvert) {
    conversionRates[currency] = await getExchangeRate(currency, defaultCurrency);
  }
  const convertedGroups = groups.map((group) => ({
    ...group,
    balances: group.balances.map((balance) => ({
      ...balance,
      convertedBalance: (Number(balance.netBalance) * (conversionRates[balance.currency] || 1)).toFixed(2),
    })),
    expenseTotals: [...(expenseTotalsByGroup.get(group.groupId) || new Map()).entries()].map(([currency, total]) => ({
      currency,
      amount: total.toFixed(2),
      convertedAmount: total.mul(conversionRates[currency] || 1).toFixed(2),
    })),
  }));
  return {
    friend,
    defaultCurrency,
    groups: convertedGroups,
    transactions: personalTransactions.sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt)),
    exchangeRates: conversionRates,
  };
};

export const settleFriendBalances = async ({
  userId,
  friendId,
  payerId,
  amount,
  currency,
  mode,
  selections = [],
  note = null,
}) => {
  if (![userId, friendId, payerId].every(validId) || userId === friendId
    || ![userId, friendId].includes(payerId)) {
    throw Object.assign(new Error('Choose a valid payer and friend'), { statusCode: 400 });
  }
  if (!currencies.includes(currency)) {
    throw Object.assign(new Error('Choose a supported payment currency'), { statusCode: 400 });
  }
  if (!['selected', 'all'].includes(mode)) {
    throw Object.assign(new Error('Choose selected balances or all friend balances'), { statusCode: 400 });
  }
  if (mode === 'selected' && (!Array.isArray(selections) || !selections.length)) {
    throw Object.assign(new Error('Select at least one group balance to settle'), { statusCode: 400 });
  }
  if (mode === 'selected' && selections.some((selection) => (
    !selection || !validId(selection.groupId) || !currencies.includes(selection.currency)
  ))) {
    throw Object.assign(new Error('Choose valid group balances to settle'), { statusCode: 400 });
  }
  if (note !== null && (typeof note !== 'string' || note.length > 500)) {
    throw Object.assign(new Error('Payment note must be 500 characters or fewer'), { statusCode: 400 });
  }
  let paymentAmount;
  try {
    paymentAmount = new Decimal(amount);
  } catch {
    throw Object.assign(new Error('Enter a valid payment amount'), { statusCode: 400 });
  }
  if (!paymentAmount.isFinite() || paymentAmount.lte(0) || paymentAmount.decimalPlaces() > 2) {
    throw Object.assign(new Error('Payment amount must be positive and use at most two decimal places'), { statusCode: 400 });
  }

  const [lowId, highId] = pairKey(userId, friendId);
  const friendship = await query(
    'SELECT 1 FROM friendships WHERE user_low = $1 AND user_high = $2',
    [lowId, highId],
  );
  if (!friendship.rowCount) throw Object.assign(new Error('Friend not found'), { statusCode: 404 });
  const eligibleRows = await query(
    `SELECT b.group_id AS "groupId", b.currency, b.net_owed::text AS amount,
            g.name AS "groupName", g.is_friend_ledger AS "isDirect"
     FROM balances b JOIN groups g ON g.id = b.group_id
     WHERE b.user1 = $1 AND b.user2 = $2 AND b.net_owed <> 0
       AND (
         g.is_friend_ledger
         OR EXISTS (
           SELECT 1 FROM group_members a JOIN group_members f ON f.group_id = a.group_id
           WHERE a.group_id = g.id AND a.user_id = $3 AND f.user_id = $4
         )
       )`,
    [lowId, highId, lowId, highId],
  );
  const requestedKeys = mode === 'all'
    ? null
    : new Set(selections.map((selection) => `${selection.groupId}:${selection.currency}`));
  const directionFactor = payerId === lowId ? -1 : 1;
  const candidates = eligibleRows.rows
    .filter((row) => (mode === 'all' || requestedKeys.has(`${row.groupId}:${row.currency}`))
      && Math.sign(Number(row.amount)) === directionFactor)
    .sort((first, second) => `${first.groupName}:${first.currency}`.localeCompare(`${second.groupName}:${second.currency}`));
  if (mode === 'selected' && candidates.length !== requestedKeys.size) {
    throw Object.assign(new Error('One or more selected balances are no longer available in that payment direction'), { statusCode: 409 });
  }
  if (!candidates.length) {
    throw Object.assign(new Error('There is no outstanding balance in that payment direction'), { statusCode: 400 });
  }

  const rates = new Map();
  let maxPayment = new Decimal(0);
  // Convert each selected source balance to the requested payment currency before allocation.
  for (const candidate of candidates) {
    const rate = await getExchangeRate(candidate.currency, currency);
    rates.set(candidate.currency, rate);
    maxPayment = maxPayment.plus(
      new Decimal(candidate.amount).abs().mul(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
    );
  }
  if (paymentAmount.gt(maxPayment)) {
    throw Object.assign(new Error(`Payment cannot exceed ${currency} ${maxPayment.toFixed(2)} for the selected balances`), { statusCode: 400 });
  }

  return withTransaction(async (client) => {
    await assertFriends(client, userId, friendId);
    const groupIds = [...new Set(candidates.map((candidate) => candidate.groupId))];
    const locked = await client.query(
      `SELECT group_id, currency, net_owed::text AS amount
       FROM balances
       WHERE group_id = ANY($1::uuid[]) AND user1 = $2 AND user2 = $3
       ORDER BY group_id, currency FOR UPDATE`,
      [groupIds, lowId, highId],
    );
    const currentRows = new Map(locked.rows.map((row) => [`${row.group_id}:${row.currency}`, row]));
    const lockedCandidates = candidates.filter((candidate) => {
      const current = currentRows.get(`${candidate.groupId}:${candidate.currency}`);
      return current && Math.sign(Number(current.amount)) === directionFactor;
    });
    if (mode === 'selected' && lockedCandidates.length !== requestedKeys.size) {
      throw Object.assign(new Error('One or more selected balances changed. Refresh and try again.'), { statusCode: 409 });
    }
    let remaining = paymentAmount;
    const allocations = [];
    // Allocate in a stable order so one payment can settle balances from several currencies/groups.
    for (const candidate of candidates) {
      if (remaining.lte(0)) break;
      const balance = currentRows.get(`${candidate.groupId}:${candidate.currency}`);
      if (!balance) continue;
      const sourceBalance = new Decimal(balance.amount);
      const outstanding = payerId === lowId ? sourceBalance.negated() : sourceBalance;
      if (!outstanding.isPositive()) continue;
      const rate = rates.get(candidate.currency);
      const sourceAmount = Decimal.min(
        outstanding,
        remaining.div(rate).toDecimalPlaces(2, Decimal.ROUND_DOWN),
      );
      if (sourceAmount.lte(0)) continue;
      const paidAmount = sourceAmount.mul(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const signedDelta = payerId === lowId ? sourceAmount : sourceAmount.negated();
      await client.query(
        'UPDATE balances SET net_owed = net_owed + $1, updated_at = NOW() WHERE group_id = $2 AND user1 = $3 AND user2 = $4 AND currency = $5',
        [signedDelta.toFixed(2), candidate.groupId, lowId, highId, candidate.currency],
      );
      allocations.push({
        groupId: candidate.groupId,
        amount: sourceAmount.toFixed(2),
        currency: candidate.currency,
        exchangeRate: rate,
        paidAmount: paidAmount.toFixed(2),
      });
      remaining = Decimal.max(0, remaining.minus(paidAmount));
    }
    if (remaining.gt('0.01') || !allocations.length) {
      throw Object.assign(new Error('Payment amount could not be allocated to the current balances. Refresh and try again.'), { statusCode: 409 });
    }
    const settlement = await client.query(
      `INSERT INTO friend_settlements (paid_by, paid_to, amount, currency, note)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id AS "_id", paid_by AS "paidBy", paid_to AS "paidTo",
                 amount::text AS "totalAmount", currency, note, created_at AS "createdAt"`,
      [payerId, payerId === userId ? friendId : userId, paymentAmount.toFixed(2), currency, note?.trim() || null],
    );
    for (const allocation of allocations) {
      await client.query(
        `INSERT INTO friend_settlement_allocations (settlement_id, group_id, amount, currency, exchange_rate)
         VALUES ($1,$2,$3,$4,$5)`,
        [settlement.rows[0]._id, allocation.groupId, allocation.amount, allocation.currency, allocation.exchangeRate],
      );
    }
    const payer = await client.query('SELECT fullnamae FROM users WHERE id = $1', [payerId]);
    const payeeId = payerId === userId ? friendId : userId;
    const details = `${payer.rows[0]?.fullnamae || 'A friend'} paid ${currency} ${paymentAmount.toFixed(2)}.`;
    await client.query(
      `INSERT INTO notifications (user_id, message, created_by, notification_type)
       VALUES ($1,$2,$3,'PAYMENT_RECEIVED')`,
      [payeeId, details, payerId],
    );
    await queueEmailNotification(client, payeeId, 'paymentReceived', 'You received a SplitCare payment', details);
    return { ...settlement.rows[0], allocations };
  });
};
