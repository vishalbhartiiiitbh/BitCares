import test from 'node:test';
import assert from 'node:assert/strict';
import { isFeatureEnabled } from './featureAccessService.js';

test('free features are disabled unless platform settings explicitly enable them', () => {
  assert.equal(isFeatureEnabled({}, false, 'currencyConversion'), false);
  assert.equal(isFeatureEnabled({
    features: { currencyConversion: { free: true, premium: true } },
  }, false, 'currencyConversion'), true);
});

test('premium features are enabled by default and respect explicit platform disablement', () => {
  assert.equal(isFeatureEnabled({}, true, 'groupSpendingInsights'), true);
  assert.equal(isFeatureEnabled({
    features: { dashboardSpendingInsights: { free: true, premium: false } },
  }, true, 'dashboardSpendingInsights'), false);
});
