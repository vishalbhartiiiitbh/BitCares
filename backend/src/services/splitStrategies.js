import Decimal from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const MONEY_SCALE = new Decimal(100);
const invalidInput = (message) => Object.assign(new Error(message), { statusCode: 400 });
const asDecimal = (value, label = 'amount') => {
  try {
    const decimal = new Decimal(value);
    if (!decimal.isFinite() || decimal.isNegative()) throw new Error();
    return decimal;
  } catch {
    throw invalidInput(`Invalid ${label}`);
  }
};

const toMoney = (value) => asDecimal(value).toDecimalPlaces(2);
const toMinorUnits = (value) => toMoney(value).mul(MONEY_SCALE).toDecimalPlaces(0);

export class SplitStrategy {
  calculateSplits() {
    throw new Error('calculateSplits must be implemented');
  }
}

export class EqualSplitStrategy extends SplitStrategy {
  calculateSplits(totalAmount, participants) {
    if (!Array.isArray(participants) || participants.length === 0) throw invalidInput('At least one participant is required');
    const total = toMinorUnits(totalAmount);
    const base = total.div(participants.length).floor();
    // Distribute leftover cents in participant order so the shares add up exactly.
    let remainder = total.minus(base.mul(participants.length)).toNumber();
    return participants.map((userId) => {
      const amount = base.plus(remainder > 0 ? 1 : 0);
      remainder -= remainder > 0 ? 1 : 0;
      return { userId, amountOwed: amount.div(MONEY_SCALE), splitValue: amount.div(MONEY_SCALE) };
    });
  }
}

export class ExactSplitStrategy extends SplitStrategy {
  calculateSplits(totalAmount, participants, values) {
    if (!Array.isArray(values) || values.length !== participants.length) throw invalidInput('Exact values must match participants');
    const amounts = values.map((value) => toMoney(asDecimal(value, 'exact amount')));
    const sum = amounts.reduce((result, amount) => result.plus(amount), new Decimal(0));
    if (!sum.eq(toMoney(totalAmount))) throw invalidInput('Exact split values must equal total amount');
    return participants.map((userId, index) => ({ userId, amountOwed: amounts[index], splitValue: amounts[index] }));
  }
}

export class PercentageSplitStrategy extends SplitStrategy {
  calculateSplits(totalAmount, participants, values) {
    if (!Array.isArray(values) || values.length !== participants.length) throw invalidInput('Percentages must match participants');
    const percentages = values.map((value) => asDecimal(value, 'percentage'));
    const sum = percentages.reduce((result, value) => result.plus(value), new Decimal(0));
    if (!sum.eq(100)) throw invalidInput('Percentages must equal 100');
    const totalMinor = toMinorUnits(totalAmount);
    const amounts = percentages.map((percentage) => totalMinor.mul(percentage).div(100).toDecimalPlaces(0, Decimal.ROUND_DOWN));
    // Rounding down avoids over-allocating; assign the remaining cents deterministically.
    const remainder = totalMinor.minus(amounts.reduce((result, amount) => result.plus(amount), new Decimal(0)));
    amounts[0] = amounts[0].plus(remainder);
    return participants.map((userId, index) => ({ userId, amountOwed: amounts[index].div(MONEY_SCALE), splitValue: percentages[index] }));
  }
}

export class SharesSplitStrategy extends SplitStrategy {
  calculateSplits(totalAmount, participants, values) {
    if (!Array.isArray(values) || values.length !== participants.length) throw invalidInput('Share values must match participants');
    const shares = values.map((value) => {
      let amount;
      try {
        amount = new Decimal(value);
      } catch {
        throw invalidInput('Share values must be valid numbers');
      }
      if (!amount.isFinite() || amount.lte(0)) throw invalidInput('Each participant must have at least one share');
      return amount;
    });
    const totalShares = shares.reduce((sum, share) => sum.plus(share), new Decimal(0));
    const totalMinor = toMinorUnits(totalAmount);
    const amounts = shares.map((share) => totalMinor.mul(share).div(totalShares).toDecimalPlaces(0, Decimal.ROUND_DOWN));
    // Keep proportional shares exact to the cent by assigning any remainder to the first participant.
    const remainder = totalMinor.minus(amounts.reduce((sum, amount) => sum.plus(amount), new Decimal(0)));
    amounts[0] = amounts[0].plus(remainder);
    return participants.map((userId, index) => ({ userId, amountOwed: amounts[index].div(MONEY_SCALE), splitValue: shares[index] }));
  }
}

export class AdjustmentSplitStrategy extends SplitStrategy {
  calculateSplits(totalAmount, participants, values) {
    if (!Array.isArray(values) || values.length !== participants.length) throw invalidInput('Adjustment values must match participants');
    const adjustments = values.map((value) => {
      let amount;
      try {
        amount = new Decimal(value);
      } catch {
        throw invalidInput('Adjustment values must be valid amounts');
      }
      if (!amount.isFinite()) throw invalidInput('Adjustment values must be valid amounts');
      return amount.toDecimalPlaces(2);
    });
    const adjustmentTotal = adjustments.reduce((sum, value) => sum.plus(value), new Decimal(0));
    if (!adjustmentTotal.eq(0)) throw invalidInput('Adjustments must balance to zero');
    const totalMinor = toMinorUnits(totalAmount);
    const base = totalMinor.div(participants.length).floor();
    let remainder = totalMinor.minus(base.mul(participants.length)).toNumber();
    const equalAmounts = participants.map(() => {
      const amount = base.plus(remainder > 0 ? 1 : 0);
      remainder -= remainder > 0 ? 1 : 0;
      return amount;
    });
    const amounts = equalAmounts.map((amount, index) => amount.plus(adjustments[index].mul(MONEY_SCALE)));
    if (amounts.some((amount) => amount.isNegative())) throw invalidInput('Adjustments cannot reduce anyone below zero');
    if (!amounts.reduce((sum, amount) => sum.plus(amount), new Decimal(0)).eq(totalMinor)) {
      throw invalidInput('Adjusted shares must still equal the total amount');
    }
    return participants.map((userId, index) => ({ userId, amountOwed: amounts[index].div(MONEY_SCALE), splitValue: adjustments[index] }));
  }
}

const strategies = {
  EQUAL: EqualSplitStrategy,
  EXACT: ExactSplitStrategy,
  REIMBURSEMENT: ExactSplitStrategy,
  ITEMIZED: ExactSplitStrategy,
  PERCENTAGE: PercentageSplitStrategy,
  SHARES: SharesSplitStrategy,
  ADJUSTMENT: AdjustmentSplitStrategy,
};

export class SplitStrategyFactory {
  static get(strategy) {
    const Strategy = strategies[strategy];
    if (!Strategy) throw new Error(`Unsupported split strategy: ${strategy}`);
    return new Strategy();
  }
}