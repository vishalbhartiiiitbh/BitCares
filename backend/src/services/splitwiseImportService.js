import { createHash, randomUUID } from 'node:crypto';
import { withTransaction } from '../db/index.js';
import { normalizeGroupBalances } from './groupCurrencyService.js';
import { isFeatureEnabled } from './featureAccessService.js';
import {
  allocateSplitwiseExpense,
  parseSplitwiseCsv,
  splitwisePaymentBalanceDelta,
  validateSplitwiseMemberMappings,
} from './splitwiseCsv.js';

/** Check that a database identifier is UUID-shaped before processing an import. */
const validId = (id) => typeof id === 'string'
  && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);

/** Map a Splitwise category label to the closest supported app category. */
const categoryForSplitpayerly = (category) => {
  const normalized = category.trim().toLocaleLowerCase();
  if (['groceries', 'dining out', 'food', 'liquor'].includes(normalized)) return 'Food and drink';
  if (['rent', 'household supplies', 'home'].includes(normalized)) return 'Home';
  if (['medical expenses', 'health', 'gifts'].includes(normalized)) return 'Life';
  if (['water', 'utilities'].includes(normalized)) return 'Utilities';
  if (['car', 'bus/train', 'gas/fuel', 'heat/gas', 'transportation'].includes(normalized)) return 'Transportation';
  return 'Uncategorized';
};

/** Convert integer cents to a fixed two-decimal database amount. */
const centsToAmount = (cents) => (cents / 100).toFixed(2);

/** Insert large import collections in bounded batches to stay within query limits. */
const insertRowsInBatches = async (client, table, columns, rows) => {
  const batchSize = 500;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values = [];
    const tuples = batch.map((row) => {
      const placeholders = row.map((value) => {
        values.push(value);
        return `$${values.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`,
      values,
    );
  }
};

/** Accumulate one signed pairwise balance change for the import summary. */
const addBalanceDelta = (deltas, groupId, firstId, secondId, currency, cents) => {
  const [user1, user2] = [firstId, secondId].sort();
  const key = `${user1}:${user2}:${currency}`;
  deltas.set(key, {
    user1,
    user2,
    currency,
    cents: (deltas.get(key)?.cents || 0) + cents,
  });
};

/** Replace CSV member names with app accounts and combine duplicate mapped shares. */
const mergeMemberBalances = (transaction, memberMappings) => {
  const balances = new Map();
  for (const balance of transaction.balances) {
    const userId = memberMappings[balance.memberName];
    balances.set(userId, (balances.get(userId) || 0) + balance.cents);
  }
  return [...balances.entries()].map(([userId, cents]) => ({ userId, cents }));
};

/**
 * Check that a requester belongs to the target group and return a validated CSV preview.
 * @param {{ groupId: string, userId: string, csvText: string }} input Upload preview details.
 */
/** Validate import eligibility and return a balance-aware preview without writing data. */
export const previewSplitwiseImport = async ({ groupId, userId, csvText }) => {
  if (!validId(groupId) || !validId(userId)) {
    throw Object.assign(new Error('Choose a valid group.'), { statusCode: 400 });
  }
  const result = await withTransaction(async (client) => {
    const group = await client.query(
      `SELECT g.id
         FROM groups g JOIN group_members gm ON gm.group_id = g.id
        WHERE g.id = $1 AND gm.user_id = $2
          AND NOT g.is_personal AND NOT g.is_friend_ledger`,
      [groupId, userId],
    );
    if (!group.rowCount) throw Object.assign(new Error('Group or membership not found'), { statusCode: 404 });
    return parseSplitwiseCsv(csvText);
  });
  const payments = result.transactions.filter((transaction) => transaction.isPayment).length;
  const multiPayerExpenses = result.transactions.filter((transaction) => !transaction.isPayment && transaction.payerCount > 1).length;
  return {
    memberNames: result.memberNames,
    transactionCount: result.transactions.length,
    expenseCount: result.transactions.length - payments,
    paymentCount: payments,
    multiPayerExpenses,
    summaryRows: result.summaryRows,
    currencies: [...new Set(result.transactions.map((transaction) => transaction.currency))],
  };
};

/**
 * Import a validated Splitwise export as dated group expenses and payment records.
 * Mappings associate each Splitwise member column with a current member's Splitpayerly user ID.
 * @param {{ groupId: string, userId: string, csvText: string, memberMappings: Record<string, string> }} input Import request details.
 */
/** Import mapped Splitwise transactions and recalculate group balances atomically. */
export const importSplitwiseCsv = async ({ groupId, userId, csvText, memberMappings }) => {
  const parsed = parseSplitwiseCsv(csvText);
  if (!validId(groupId) || !validId(userId)) {
    throw Object.assign(new Error('Choose a valid group.'), { statusCode: 400 });
  }
  const mappedIds = validateSplitwiseMemberMappings(parsed.memberNames, memberMappings);
  const normalizedMappings = Object.fromEntries(
    parsed.memberNames.map((name, index) => [name, mappedIds[index]]),
  );

  const fileHash = createHash('sha256').update(csvText).digest('hex');
  const result = await withTransaction(async (client) => {
    const groupResult = await client.query(
      `SELECT g.id, g.name, g.currency
         FROM groups g JOIN group_members gm ON gm.group_id = g.id
        WHERE g.id = $1 AND gm.user_id = $2
          AND NOT g.is_personal AND NOT g.is_friend_ledger
        FOR UPDATE OF g`,
      [groupId, userId],
    );
    if (!groupResult.rowCount) throw Object.assign(new Error('Group or membership not found'), { statusCode: 404 });
    const needsCurrencyConversion = parsed.transactions.some(
      (transaction) => transaction.currency !== (groupResult.rows[0].currency || 'INR'),
    );
    if (needsCurrencyConversion) {
      const entitlementResult = await client.query(
        `SELECT u.plan, u.premium_until AS "premiumUntil", s.settings
           FROM users u CROSS JOIN platform_settings s
          WHERE u.id = $1`,
        [userId],
      );
      const entitlement = entitlementResult.rows[0];
      const isPremium = entitlement.plan === 'premium'
        && (!entitlement.premiumUntil || new Date(entitlement.premiumUntil) > new Date());
      if (!isFeatureEnabled(entitlement.settings, isPremium, 'currencyConversion')) {
        throw Object.assign(new Error('Importing expenses in other currencies requires Premium currency conversion. Ask an admin to enable it for free users or import expenses in the group currency.'), { statusCode: 402 });
      }
    }

    const memberResult = await client.query(
      'SELECT user_id FROM group_members WHERE group_id = $1 AND user_id = ANY($2::uuid[])',
      [groupId, mappedIds],
    );
    if (memberResult.rowCount !== mappedIds.length) {
      throw Object.assign(new Error('Every mapped Splitpayerly account must already belong to this group. Add missing members, then retry the import.'), { statusCode: 400 });
    }

    const importRecord = await client.query(
      `INSERT INTO splitwise_imports (group_id, source_hash, imported_by, transaction_count)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (group_id, source_hash) DO NOTHING
       RETURNING id`,
      [groupId, fileHash, userId, parsed.transactions.length],
    );
    if (!importRecord.rowCount) {
      throw Object.assign(new Error('This exact CSV has already been imported into this group.'), { statusCode: 409 });
    }

    const users = await client.query(
      'SELECT id, fullnamae, username FROM users WHERE id = ANY($1::uuid[])',
      [mappedIds],
    );
    const userById = new Map(users.rows.map((user) => [user.id, user]));
    const importedExpenses = [];
    const importedSplits = [];
    const importedPayments = [];
    const balanceDeltas = new Map();
    let expenseCount = 0;
    let paymentCount = 0;
    let multiPayerExpenseCount = 0;

    for (const transaction of parsed.transactions) {
      const balances = mergeMemberBalances(transaction, normalizedMappings);
      if (transaction.isPayment) {
        const payer = balances.find((balance) => balance.cents > 0);
        const payee = balances.find((balance) => balance.cents < 0);
        if (!payer || !payee || payer.userId === payee.userId) {
          throw Object.assign(new Error(`Row ${transaction.rowNumber}: map the payment's payer and recipient to different Splitpayerly accounts.`), { statusCode: 400 });
        }
        const details = `Splitwise payment imported: ${transaction.description}`;
        addBalanceDelta(
          balanceDeltas,
          groupId,
          payer.userId,
          payee.userId,
          transaction.currency,
          splitwisePaymentBalanceDelta(payer.userId, payee.userId, transaction.costCents),
        );
        importedPayments.push([
          randomUUID(),
          groupId,
          payer.userId,
          payee.userId,
          centsToAmount(transaction.costCents),
          transaction.currency,
          details,
          transaction.date,
        ]);
        paymentCount += 1;
        continue;
      }

      const allocations = allocateSplitwiseExpense(transaction, balances);
      if (allocations.length > 1) multiPayerExpenseCount += 1;
      for (const allocation of allocations) {
        const payerName = userById.get(allocation.userId)?.fullnamae
          || userById.get(allocation.userId)?.username
          || 'Group member';
        const description = allocations.length > 1
          ? `${transaction.description} (Splitwise import; paid by ${payerName})`.slice(0, 500)
          : transaction.description.slice(0, 500);
        const amount = centsToAmount(allocation.cents);
        const category = categoryForSplitpayerly(transaction.sourceCategory);
        const expenseId = randomUUID();
        importedExpenses.push([
          expenseId,
          groupId,
          description,
          amount,
          transaction.currency,
          'EXACT',
          allocation.userId,
          'EXPENSE',
          category,
          `Imported from Splitwise · Original category: ${transaction.sourceCategory}`.slice(0, 1000),
          transaction.date,
        ]);
        for (const split of allocation.splits) {
          const splitAmount = centsToAmount(split.cents);
          importedSplits.push([expenseId, split.userId, splitAmount, splitAmount]);
          if (split.userId !== allocation.userId) {
            const [payerPairFirst] = [allocation.userId, split.userId].sort();
            addBalanceDelta(
              balanceDeltas,
              groupId,
              allocation.userId,
              split.userId,
              transaction.currency,
              allocation.userId === payerPairFirst ? split.cents : -split.cents,
            );
          }
        }
        expenseCount += 1;
      }
    }

    await insertRowsInBatches(
      client,
      'expenses',
      ['id', 'group_id', 'description', 'total_amount', 'currency', 'split_strategy', 'paid_by', 'type', 'category', 'note', 'created_at'],
      importedExpenses,
    );
    await insertRowsInBatches(
      client,
      'expense_splits',
      ['expense_id', 'user_id', 'amount_owed', 'split_value'],
      importedSplits,
    );
    await insertRowsInBatches(
      client,
      'group_settlements',
      ['id', 'group_id', 'paid_by', 'paid_to', 'amount', 'currency', 'note', 'created_at'],
      importedPayments,
    );
    const nonzeroBalances = [...balanceDeltas.values()].filter((balance) => balance.cents !== 0);
    for (let offset = 0; offset < nonzeroBalances.length; offset += 500) {
      const batch = nonzeroBalances.slice(offset, offset + 500);
      const values = [];
      const tuples = batch.map((balance) => {
        const rowValues = [
          groupId,
          balance.user1,
          balance.user2,
          balance.currency,
          centsToAmount(balance.cents),
        ];
        const placeholders = rowValues.map((value) => {
          values.push(value);
          return `$${values.length}`;
        });
        return `(${placeholders.join(', ')})`;
      });
      await client.query(
        `INSERT INTO balances (group_id, user1, user2, currency, net_owed)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (group_id, user1, user2, currency)
         DO UPDATE SET net_owed = balances.net_owed + EXCLUDED.net_owed, updated_at = NOW()`,
        values,
      );
    }

    await client.query(
      `INSERT INTO group_activity
         (group_id, actor_id, activity_type, description, details, amount, currency)
       VALUES ($1, $2, 'SPLITWISE_IMPORTED', 'Splitwise history imported', $3, NULL, NULL)`,
      [
        groupId,
        userId,
        `Imported ${expenseCount} expenses and ${paymentCount} payments from Splitwise into ${groupResult.rows[0].name}.`,
      ],
    );

    return {
      expenseCount,
      paymentCount,
      multiPayerExpenseCount,
      summaryRowsSkipped: parsed.summaryRows,
      sourceTransactions: parsed.transactions.length,
    };
  });
  await normalizeGroupBalances(groupId, userId);
  return result;
};
