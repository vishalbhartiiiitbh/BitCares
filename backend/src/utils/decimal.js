import Decimal from 'decimal.js';

/** Convert numeric-like values to Decimal without losing string precision. */
export const decimalValue = (value) => new Decimal(value?.toString?.() ?? value);
/** Serialize a value as a two-decimal Mongo-compatible Decimal128 representation. */
export const decimal128 = (value) => ({ $numberDecimal: decimalValue(value).toFixed(2) });