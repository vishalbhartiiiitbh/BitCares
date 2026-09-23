import Decimal from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const MONEY_SCALE = new Decimal(100);
const asDecimal = (value, label = 'amount') => {
  try {
    const decimal = new Decimal(value);
    if (!decimal.isFinite() || decimal.isNegative()) throw new Error();
    return decimal;
  } catch {
    throw new Error(`Invalid ${label}`);
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
    if (!Array.isArray(participants) || participants.length === 0) throw new Error('At least one participant is required');
    const total = toMinorUnits(totalAmount);
    const base = total.div(participants.length).floor();
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
    if (!Array.isArray(values) || values.length !== participants.length) throw new Error('Exact values must match participants');
    const amounts = values.map((value) => toMoney(asDecimal(value, 'exact amount')));
    const sum = amounts.reduce((result, amount) => result.plus(amount), new Decimal(0));
    if (!sum.eq(toMoney(totalAmount))) throw new Error('Exact split values must equal total amount');
    return participants.map((userId, index) => ({ userId, amountOwed: amounts[index], splitValue: amounts[index] }));
  }
}

export class PercentageSplitStrategy extends SplitStrategy {
  calculateSplits(totalAmount, participants, values) {
    if (!Array.isArray(values) || values.length !== participants.length) throw new Error('Percentages must match participants');
    const percentages = values.map((value) => asDecimal(value, 'percentage'));
    const sum = percentages.reduce((result, value) => result.plus(value), new Decimal(0));
    if (!sum.eq(100)) throw new Error('Percentages must equal 100');
    const totalMinor = toMinorUnits(totalAmount);
    const amounts = percentages.map((percentage) => totalMinor.mul(percentage).div(100).toDecimalPlaces(0, Decimal.ROUND_DOWN));
    const remainder = totalMinor.minus(amounts.reduce((result, amount) => result.plus(amount), new Decimal(0)));
    amounts[0] = amounts[0].plus(remainder);
    return participants.map((userId, index) => ({ userId, amountOwed: amounts[index].div(MONEY_SCALE), splitValue: percentages[index] }));
  }
}

const strategies = { EQUAL: EqualSplitStrategy, EXACT: ExactSplitStrategy, PERCENTAGE: PercentageSplitStrategy };

export class SplitStrategyFactory {
  static get(strategy) {
    const Strategy = strategies[strategy];
    if (!Strategy) throw new Error(`Unsupported split strategy: ${strategy}`);
    return new Strategy();
  }
}