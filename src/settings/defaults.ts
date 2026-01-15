export const DEFAULT_APPROVAL_DEFAULTS = {
  stockAdjust: true,
  stockAdjustThresholdAmount: null,
  refund: true,
  purchase: true,
  transfer: true,
  expense: false,
  discountThresholdPercent: 10,
  discountThresholdAmount: null,
};

export { DEFAULT_NOTIFICATION_SETTINGS } from '../notifications/notification-config';

export const DEFAULT_STOCK_POLICIES = {
  negativeStockAllowed: false,
  fifoMode: 'FIFO',
  valuationMethod: 'FIFO',
  expiryPolicy: 'WARN',
  expiryAlertDays: 30,
  batchTrackingEnabled: false,
  transferBatchPolicy: 'PRESERVE',
  lowStockThreshold: 5,
};

export const DEFAULT_POS_POLICIES = {
  receiptTemplate: 'THERMAL',
  receiptHeader: '',
  receiptFooter: 'Thank you for your business.',
  showBranchContact: true,
  creditEnabled: false,
  shiftTrackingEnabled: false,
  shiftVarianceThreshold: 50000,
  discountThresholdPercent: 10,
  discountThresholdAmount: 50000,
  refundReturnToStockDefault: true,
  offlinePriceVariancePercent: 3,
  offlineLimits: {
    maxDurationHours: 72,
    maxSalesCount: 200,
    maxTotalValue: 5000000,
  },
};

export const DEFAULT_LOCALE_SETTINGS = {
  currency: 'TZS',
  timezone: 'Africa/Dar_es_Salaam',
  dateFormat: 'DD/MM/YYYY',
};

export const DEFAULT_ONBOARDING = {
  enabled: true,
  enforced: true,
  businessProfileComplete: false,
  branchSetupComplete: false,
  teamSetupSkipped: false,
};
