const dailyRates = new Map();
let currencyCodesCache = null;
let currencyCodesExpiresAt = 0;

/** Fetch all latest conversion rates for a base currency from the configured provider. */
const getLatestRates = async (baseCurrency) => {
  const apiKey = process.env.EXCHANGE_RATE_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error('Currency conversion is not configured on the server'), { statusCode: 503 });
  }

  let response;
  try {
    response = await fetch(
      `https://v6.exchangerate-api.com/v6/${encodeURIComponent(apiKey)}/latest/${baseCurrency}`,
      { signal: AbortSignal.timeout(8000) },
    );
  } catch (error) {
    throw Object.assign(new Error('Exchange rates are temporarily unavailable. Please try again.'), {
      statusCode: 503,
      cause: error,
    });
  }
  if (!response.ok) {
    throw Object.assign(new Error('Exchange rates are temporarily unavailable. Please try again.'), { statusCode: 503 });
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw Object.assign(new Error('The exchange-rate response was invalid. Please try again.'), {
      statusCode: 502,
      cause: error,
    });
  }
  if (data.result !== 'success' || !data.conversion_rates || typeof data.conversion_rates !== 'object') {
    const statusCode = data['error-type'] === 'unsupported-code' ? 400 : 503;
    const message = data['error-type'] === 'unsupported-code'
      ? 'The exchange-rate provider does not support this currency'
      : 'Exchange rates are temporarily unavailable. Please try again.';
    throw Object.assign(new Error(message), { statusCode });
  }
  return data;
};

/** Return the supported currency codes reported by the exchange-rate provider. */
export const getAvailableCurrencies = async () => {
  if (currencyCodesCache && currencyCodesExpiresAt > Date.now()) return currencyCodesCache;
  const data = await getLatestRates('USD');
  const currencies = Object.keys(data.conversion_rates)
    .filter((code) => /^[A-Z]{3}$/.test(code))
    .sort();
  currencyCodesCache = currencies;
  currencyCodesExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
  return currencies;
};

/** Return a cached or freshly fetched conversion rate between two currencies. */
export const getExchangeRate = async (fromCurrency, toCurrency) => {
  if (!/^[A-Z]{3}$/.test(fromCurrency) || !/^[A-Z]{3}$/.test(toCurrency)) {
    throw Object.assign(new Error('Enter valid three-letter currency codes'), { statusCode: 400 });
  }
  if (fromCurrency === toCurrency) return 1;

  const cacheKey = `${fromCurrency}:${toCurrency}`;
  const cached = dailyRates.get(cacheKey);
  // Avoid repeated provider calls for the same currency pair during the cache window.
  if (cached && cached.expiresAt > Date.now()) return cached.rate;

  const data = await getLatestRates(fromCurrency);
  const rate = Number(data.conversion_rates?.[toCurrency]);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw Object.assign(new Error('The exchange-rate response was invalid. Please try again.'), { statusCode: 502 });
  }
  dailyRates.set(cacheKey, { rate, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
  return rate;
};
