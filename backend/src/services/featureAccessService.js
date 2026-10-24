import { query } from '../db/index.js';

const featureDefaults = {
  currencyConversion: false,
  dashboardSpendingInsights: false,
  groupSpendingInsights: false,
};

export const isFeatureEnabled = (settings, isPremium, feature) => {
  const featureSettings = settings?.features?.[feature];
  return isPremium
    ? featureSettings?.premium !== false
    : Boolean(featureSettings?.free ?? featureDefaults[feature]);
};

export const getUserFeatureAccess = async (userId) => {
  const result = await query(
    `SELECT u.plan, u.premium_until AS "premiumUntil", s.settings
       FROM users u CROSS JOIN platform_settings s
      WHERE u.id = $1`,
    [userId],
  );
  if (!result.rowCount) throw Object.assign(new Error('User not found'), { statusCode: 404 });
  const { plan, premiumUntil, settings } = result.rows[0];
  const isPremium = plan === 'premium'
    && (!premiumUntil || new Date(premiumUntil) > new Date());
  return {
    isPremium,
    features: Object.fromEntries(
      Object.keys(featureDefaults).map((feature) => [
        feature,
        isFeatureEnabled(settings, isPremium, feature),
      ]),
    ),
  };
};
