/**
 * Valid ISO 4217 currency codes accepted by this application.
 * Must stay in sync with frontend/src/lib/currencies.ts.
 * To add a new currency, add the code here AND in the frontend list.
 */
export const VALID_CURRENCY_CODES: ReadonlySet<string> = new Set([
  'TZS',
  'KES',
  'UGX',
  'RWF',
  'ETB',
  'ZAR',
  'NGN',
  'GHS',
  'MZN',
  'BWP',
  'USD',
  'EUR',
  'GBP',
  'AED',
]);
