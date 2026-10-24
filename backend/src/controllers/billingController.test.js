import test from 'node:test';
import assert from 'node:assert/strict';
import { addFreePremiumPeriod, couponQuote } from './billingController.js';

test('calculates a percentage coupon quote in paise', () => {
  const quote = couponQuote({
    code: 'SAVE20',
    discountType: 'percentage',
    discountValue: '20',
    application: 'single_use',
  }, 'monthly');

  assert.equal(quote.discountAmount, 1000);
  assert.equal(quote.finalAmount, 4000);
  assert.equal(quote.application, 'single_use');
});

test('calculates a fixed INR coupon quote in paise', () => {
  const quote = couponQuote({
    code: 'SAVE1250',
    discountType: 'fixed_inr',
    discountValue: '12.50',
    application: 'forever',
  }, 'monthly');

  assert.equal(quote.discountAmount, 1250);
  assert.equal(quote.finalAmount, 3750);
  assert.equal(quote.application, 'forever');
});

test('marks a 100% first-payment coupon as a free-period grant', () => {
  const quote = couponQuote({
    code: 'FREEPERIOD',
    discountType: 'percentage',
    discountValue: '100',
    application: 'single_use',
  }, 'monthly');

  assert.equal(quote.discountAmount, 5000);
  assert.equal(quote.finalAmount, 0);
  assert.equal(quote.isFreeGrant, true);
});

test('grants calendar billing periods without overflowing month ends', () => {
  assert.equal(
    addFreePremiumPeriod(new Date('2025-01-31T12:00:00.000Z'), 'monthly').toISOString(),
    '2025-02-28T12:00:00.000Z',
  );
  assert.equal(
    addFreePremiumPeriod(new Date('2025-01-31T12:00:00.000Z'), 'weekly').toISOString(),
    '2025-02-07T12:00:00.000Z',
  );
});

test('rejects a coupon quote that would leave one rupee or less due', () => {
  assert.throws(
    () => couponQuote({
      code: 'TOOBIG',
      discountType: 'percentage',
      discountValue: '98',
      application: 'single_use',
    }, 'monthly'),
    { message: 'This coupon discount is too large for the selected plan' },
  );
});
