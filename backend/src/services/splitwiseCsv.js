import Decimal from 'decimal.js';

const REQUIRED_COLUMNS = ['date', 'description', 'category', 'cost', 'currency'];
const MAX_TRANSACTIONS = 5000;
const MAX_CENTS = 999999999999;
const UUID_PATTERN = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Create a client-facing validation error for malformed Splitwise exports. */
const invalidCsv = (message) => Object.assign(new Error(message), { statusCode: 400 });

/** Parse CSV text into rows while respecting quoted commas, escaped quotes, and newlines. */
const parseCsvRows = (text) => {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let closedQuote = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
        closedQuote = true;
      } else {
        field += character;
      }
      continue;
    }

    if (closedQuote && character !== ',' && character !== '\n' && character !== '\r' && !/\s/.test(character)) {
      throw invalidCsv('The CSV contains text after a closing quote.');
    }
    if (closedQuote && /\s/.test(character) && character !== '\n' && character !== '\r') continue;
    if (character === '"') {
      if (field.length) throw invalidCsv('The CSV contains a quote inside an unquoted field.');
      inQuotes = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
      closedQuote = false;
    } else if (character === '\n' || character === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      closedQuote = false;
      if (character === '\r' && text[index + 1] === '\n') index += 1;
    } else {
      field += character;
    }
  }

  if (inQuotes) throw invalidCsv('The CSV has an unterminated quoted field.');
  if (field.length || row.length || closedQuote) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((values) => values.some((value) => value.trim() !== ''));
};

/** Parse a decimal amount into integer cents and reject invalid signs or precision. */
const parseCents = (value, label, rowNumber, allowNegative = false) => {
  const normalized = value.trim();
  const pattern = allowNegative ? /^-?\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d{1,2})?$/;
  if (!pattern.test(normalized)) {
    throw invalidCsv(`Row ${rowNumber}: ${label} must be a valid amount with at most two decimal places.`);
  }
  const cents = new Decimal(normalized).mul(100);
  if (!cents.isInteger() || !cents.isFinite()) {
    throw invalidCsv(`Row ${rowNumber}: ${label} is not a valid amount.`);
  }
  return cents.toNumber();
};

/** Parse a supported Splitwise date value into a stable ISO date. */
const parseDate = (value, rowNumber) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) throw invalidCsv(`Row ${rowNumber}: Date must use YYYY-MM-DD format.`);
  const [, year, month, day] = match;
  const parsed = new Date(`${year}-${month}-${day}T12:00:00.000Z`);
  if (parsed.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) {
    throw invalidCsv(`Row ${rowNumber}: Date is not a valid calendar date.`);
  }
  return parsed;
};

/**
 * Parse and validate a Splitwise expense export, including its member-balance columns.
 * Summary rows such as "Total balance" are excluded because they are not transactions.
 * @param {string} text UTF-8 CSV content.
 * @returns {{ memberNames: string[], transactions: object[], summaryRows: number }}
 */
export const parseSplitwiseCsv = (text) => {
  if (typeof text !== 'string' || !text.trim()) throw invalidCsv('Choose a non-empty Splitwise CSV file.');
  if (text.includes('\0')) throw invalidCsv('The CSV contains an invalid null character.');
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw invalidCsv('The CSV must include a header and at least one transaction.');
  if (rows.length - 1 > MAX_TRANSACTIONS) {
    throw invalidCsv(`The CSV can contain no more than ${MAX_TRANSACTIONS} transaction rows.`);
  }

  const headers = rows[0].map((value) => value.trim());
  const normalizedHeaders = headers.map((value) => value.toLocaleLowerCase());
  if (REQUIRED_COLUMNS.some((column, index) => normalizedHeaders[index] !== column)) {
    throw invalidCsv('Use the Splitwise CSV format: Date, Description, Category, Cost, Currency, followed by member names.');
  }
  const memberNames = headers.slice(REQUIRED_COLUMNS.length);
  if (!memberNames.length || memberNames.some((name) => !name)) {
    throw invalidCsv('The CSV must include a column for every Splitwise member.');
  }
  if (new Set(memberNames.map((name) => name.toLocaleLowerCase())).size !== memberNames.length) {
    throw invalidCsv('Member column names must be unique so each one can be mapped to a Splitpayerly account.');
  }

  let summaryRows = 0;
  const transactions = [];
  for (const [index, values] of rows.slice(1).entries()) {
    const rowNumber = index + 2;
    if (values.length !== headers.length) {
      throw invalidCsv(`Row ${rowNumber}: expected ${headers.length} columns but found ${values.length}.`);
    }
    const [dateValue, descriptionValue, categoryValue, costValue, currencyValue, ...memberValues] = values;
    const description = descriptionValue.trim();
    if (description.toLocaleLowerCase() === 'total balance' && !costValue.trim()) {
      summaryRows += 1;
      continue;
    }
    if (!description) throw invalidCsv(`Row ${rowNumber}: Description is required.`);

    const date = parseDate(dateValue, rowNumber);
    const costCents = parseCents(costValue, 'Cost', rowNumber);
    if (costCents <= 0 || costCents > MAX_CENTS) {
      throw invalidCsv(`Row ${rowNumber}: Cost must be greater than zero and no more than 9,999,999,999.99.`);
    }
    const currency = currencyValue.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw invalidCsv(`Row ${rowNumber}: enter a valid three-letter currency code.`);
    }

    const balances = memberValues.map((value, memberIndex) => ({
      memberName: memberNames[memberIndex],
      cents: value.trim() ? parseCents(value, memberNames[memberIndex], rowNumber, true) : 0,
    }));
    if (balances.some((balance) => Math.abs(balance.cents) > MAX_CENTS)) {
      throw invalidCsv(`Row ${rowNumber}: member balances cannot exceed 9,999,999,999.99.`);
    }
    if (balances.reduce((sum, balance) => sum + balance.cents, 0) !== 0) {
      throw invalidCsv(`Row ${rowNumber}: member balances must add up to zero.`);
    }
    const positiveTotal = balances.reduce((sum, balance) => sum + Math.max(0, balance.cents), 0);
    const negativeTotal = balances.reduce((sum, balance) => sum + Math.abs(Math.min(0, balance.cents)), 0);
    if (positiveTotal === 0 || positiveTotal !== negativeTotal) {
      throw invalidCsv(`Row ${rowNumber}: at least one member must have a non-zero balanced share.`);
    }

    const category = categoryValue.trim();
    const isPayment = category.toLocaleLowerCase() === 'payment';
    if (isPayment) {
      const payers = balances.filter((balance) => balance.cents > 0);
      const payees = balances.filter((balance) => balance.cents < 0);
      if (payers.length !== 1 || payees.length !== 1
        || payers[0].cents !== costCents || payees[0].cents !== -costCents) {
        throw invalidCsv(`Row ${rowNumber}: a payment must show one payer and one recipient for the full Cost.`);
      }
    } else if (costCents < positiveTotal) {
      throw invalidCsv(`Row ${rowNumber}: Cost is less than the recorded member balances.`);
    }

    transactions.push({
      rowNumber,
      date,
      description,
      sourceCategory: category || 'General',
      costCents,
      currency,
      balances,
      isPayment,
      payerCount: balances.filter((balance) => balance.cents > 0).length,
    });
  }

  if (!transactions.length) throw invalidCsv('The CSV does not contain any importable transactions.');
  return { memberNames, transactions, summaryRows };
};

/**
 * Validate that every CSV member maps to a distinct Splitpayerly account.
 * @param {string[]} memberNames Splitwise member column names.
 * @param {Record<string, string>} memberMappings Member-name to Splitpayerly user-ID mapping.
 * @returns {string[]} Mapped Splitpayerly user IDs in CSV member order.
 */
export const validateSplitwiseMemberMappings = (memberNames, memberMappings) => {
  if (!memberMappings || typeof memberMappings !== 'object' || Array.isArray(memberMappings)) {
    throw invalidCsv('Map every Splitwise member to a Splitpayerly group member.');
  }

  const mappedIds = memberNames.map((name) => memberMappings[name]);
  const missingOrInvalid = memberNames.find((name, index) => (
    typeof mappedIds[index] !== 'string' || !UUID_PATTERN.test(mappedIds[index])
  ));
  if (missingOrInvalid) {
    throw invalidCsv(`Choose a Splitpayerly group member for "${missingOrInvalid}".`);
  }
  const normalizedIds = mappedIds.map((id) => id.toLowerCase());
  if (new Set(normalizedIds).size !== normalizedIds.length) {
    throw invalidCsv('Each Splitwise member must map to a different Splitpayerly group member.');
  }
  return normalizedIds;
};

/**
 * Rebuild expense shares from Splitwise net balances, including expenses with multiple payers.
 * Splitwise omits the original share split in its export, so the result preserves total cost
 * and per-member net balances while allocating otherwise unknown payer shares evenly.
 * @param {{ rowNumber: number, costCents: number }} transaction Source expense details.
 * @param {{ userId: string, cents: number }[]} balances Mapped net balances for each member.
 * @returns {{ userId: string, cents: number, splits: { userId: string, cents: number }[] }[]} Expense entries to create.
 */
export const allocateSplitwiseExpense = (transaction, balances) => {
  const positive = balances.filter((balance) => balance.cents > 0);
  if (!positive.length) {
    throw invalidCsv(`Row ${transaction.rowNumber}: the selected member mappings cancel this expense out.`);
  }
  const positiveTotal = positive.reduce((sum, balance) => sum + balance.cents, 0);
  const extraShare = transaction.costCents - positiveTotal;
  if (extraShare < 0) {
    throw invalidCsv(`Row ${transaction.rowNumber}: the mapped member balances exceed the total cost.`);
  }
  const baseExtra = Math.floor(extraShare / positive.length);
  let extraRemainder = extraShare - baseExtra * positive.length;
  const extraByUser = new Map(positive.map((balance) => {
    const extra = baseExtra + (extraRemainder > 0 ? 1 : 0);
    extraRemainder -= extraRemainder > 0 ? 1 : 0;
    return [balance.userId, extra];
  }));
  const shares = balances.map((balance) => ({
    userId: balance.userId,
    cents: balance.cents < 0 ? -balance.cents : extraByUser.get(balance.userId) || 0,
  }));
  const payers = positive.map((balance) => ({
    userId: balance.userId,
    cents: balance.cents + (extraByUser.get(balance.userId) || 0),
  }));

  // Splitwise provides net balances rather than each person's original share when there
  // were multiple payers. Assign the unreported shares while preserving total cost and nets.
  const remainingShares = shares.map((share) => ({ ...share }));
  const allocations = payers.map((payer) => {
    let remainingPayment = payer.cents;
    const splits = [];
    for (const share of remainingShares) {
      const cents = Math.min(remainingPayment, share.cents);
      if (cents > 0) {
        splits.push({ userId: share.userId, cents });
        share.cents -= cents;
        remainingPayment -= cents;
      }
      if (remainingPayment === 0) break;
    }
    if (remainingPayment !== 0) {
      throw invalidCsv(`Row ${transaction.rowNumber}: could not allocate the expense shares.`);
    }
    return { ...payer, splits };
  });
  if (remainingShares.some((share) => share.cents !== 0)) {
    throw invalidCsv(`Row ${transaction.rowNumber}: expense shares do not match the total cost.`);
  }
  return allocations;
};

/**
 * Return the signed ledger change for a payment using Splitpayerly's sorted-pair convention.
 * A positive balance means the second member owes the first, so a payer in the first
 * position increases the pair balance while a payer in the second position decreases it.
 * @param {string} payerId Member who made the payment.
 * @param {string} payeeId Member who received the payment.
 * @param {number} costCents Payment amount in cents.
 * @returns {number} Signed balance change in cents.
 */
export const splitwisePaymentBalanceDelta = (payerId, payeeId, costCents) => (
  payerId < payeeId ? costCents : -costCents
);
