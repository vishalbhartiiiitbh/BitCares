import assert from 'node:assert/strict';
import test from 'node:test';
import { getAvailableCurrencies, getExchangeRate } from './exchangeRateService.js';

test('gets a conversion rate from ExchangeRate-API and caches the currency pair', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.EXCHANGE_RATE_API_KEY;
  let requestCount = 0;
  process.env.EXCHANGE_RATE_API_KEY = 'test-api-key';
  globalThis.fetch = async (url) => {
    requestCount += 1;
    assert.equal(url, 'https://v6.exchangerate-api.com/v6/test-api-key/latest/USD');
    return {
      ok: true,
      json: async () => ({ result: 'success', conversion_rates: { INR: 83.25 } }),
    };
  };

  try {
    assert.equal(await getExchangeRate('USD', 'INR'), 83.25);
    assert.equal(await getExchangeRate('USD', 'INR'), 83.25);
    assert.equal(requestCount, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.EXCHANGE_RATE_API_KEY;
    else process.env.EXCHANGE_RATE_API_KEY = previousKey;
  }
});

test('requires an API key for a conversion between different currencies', async () => {
  const previousKey = process.env.EXCHANGE_RATE_API_KEY;
  delete process.env.EXCHANGE_RATE_API_KEY;

  try {
    await assert.rejects(getExchangeRate('EUR', 'CAD'), {
      message: 'Currency conversion is not configured on the server',
      statusCode: 503,
    });
  } finally {
    if (previousKey === undefined) delete process.env.EXCHANGE_RATE_API_KEY;
    else process.env.EXCHANGE_RATE_API_KEY = previousKey;
  }
});

test('rejects malformed currency codes before calling the provider', async () => {
  await assert.rejects(getExchangeRate('US', 'INR'), {
    message: 'Enter valid three-letter currency codes',
    statusCode: 400,
  });
});

test('returns all available provider currencies', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.EXCHANGE_RATE_API_KEY;
  process.env.EXCHANGE_RATE_API_KEY = 'test-api-key';
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://v6.exchangerate-api.com/v6/test-api-key/latest/USD');
    return {
      ok: true,
      json: async () => ({
        result: 'success',
        conversion_rates: { USD: 1, INR: 95.0564, AED: 3.6725, bad: 5 },
      }),
    };
  };

  try {
    assert.deepEqual(await getAvailableCurrencies(), ['AED', 'INR', 'USD']);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.EXCHANGE_RATE_API_KEY;
    else process.env.EXCHANGE_RATE_API_KEY = previousKey;
  }
});
