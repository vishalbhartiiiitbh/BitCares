import Decimal from 'decimal.js';

export const decimalValue = (value) => new Decimal(value?.toString?.() ?? value);
export const decimal128 = (value) => ({ $numberDecimal: decimalValue(value).toFixed(2) });