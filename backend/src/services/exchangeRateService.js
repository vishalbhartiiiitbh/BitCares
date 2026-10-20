const supportedCurrencies = new Set(['INR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD']);
const dailyRates = new Map();

export const getExchangeRate = async (fromCurrency, toCurrency) => {
  if (!supportedCurrencies.has(fromCurrency) || !supportedCurrencies.has(toCurrency)) {
    throw Object.assign(new Error('Choose a supported currency for conversion'), { statusCode: 400 });
  }
  if (fromCurrency === toCurrency) return 1;

  const cacheKey = `${fromCurrency}:${toCurrency}`;
  const cached = dailyRates.get(cacheKey);
  // Avoid repeated provider calls for the same currency pair during the cache window.
  if (cached && cached.expiresAt > Date.now()) return cached.rate;

  let response;
  try {
    response = await fetch(
      `https://api.frankfurter.dev/v1/latest?base=${fromCurrency}&symbols=${toCurrency}`,
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
  const rate = Number(data.rates?.[toCurrency]);
  if (!Number.isFinite(rate) || rate <= 0 || typeof data.date !== 'string') {
    throw Object.assign(new Error('The exchange-rate response was invalid. Please try again.'), { statusCode: 502 });
  }
  dailyRates.set(cacheKey, { rate, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
  return rate;
};
