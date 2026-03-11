export const PermissionsList = {
  BUSINESS_READ: 'business.read',
  BUSINESS_UPDATE: 'business.update',
  BUSINESS_DELETE: 'business.delete',
  USERS_READ: 'users.read',
  USERS_CREATE: 'users.create',
  USERS_UPDATE: 'users.update',
  USERS_DEACTIVATE: 'users.deactivate',
  ROLES_READ: 'roles.read',
  ROLES_CREATE: 'roles.create',
  ROLES_UPDATE: 'roles.update',
  CATALOG_READ: 'catalog.read',
  CATALOG_WRITE: 'catalog.write',
  STOCK_READ: 'stock.read',
  STOCK_WRITE: 'stock.write',
  TRANSFERS_READ: 'transfers.read',
  TRANSFERS_WRITE: 'transfers.write',
  SALES_READ: 'sales.read',
  SALES_WRITE: 'sales.write',
  PURCHASES_READ: 'purchases.read',
  PURCHASES_WRITE: 'purchases.write',
  SUPPLIERS_READ: 'suppliers.read',
  SUPPLIERS_WRITE: 'suppliers.write',
  EXPENSES_READ: 'expenses.read',
  EXPENSES_WRITE: 'expenses.write',
  REPORTS_READ: 'reports.read',
  EXPORTS_WRITE: 'exports.write',
  AUDIT_READ: 'audit.read',
  OFFLINE_READ: 'offline.read',
  OFFLINE_WRITE: 'offline.write',
  ATTACHMENTS_READ: 'attachments.read',
  ATTACHMENTS_WRITE: 'attachments.write',
  CUSTOMERS_VIEW: 'customers.read',
  CUSTOMERS_CREATE: 'customers.create',
  CUSTOMERS_EDIT: 'customers.update',
  CUSTOMERS_EXPORT: 'customers.export',
  CUSTOMERS_VIEW_SENSITIVE: 'customers.sensitive.read',
  CUSTOMERS_ANONYMIZE: 'customers.anonymize',
  PRICE_LISTS_MANAGE: 'price-lists.manage',
  SHIFTS_OPEN: 'shifts.open',
  SHIFTS_CLOSE: 'shifts.close',
  SALE_CREDIT_CREATE: 'sales.credit.create',
  SALE_CREDIT_SETTLE: 'sales.credit.settle',
  RETURN_WITHOUT_RECEIPT: 'sales.return.without-receipt',
  SEARCH_READ: 'search.read',
  SETTINGS_READ: 'settings.read',
  SETTINGS_WRITE: 'settings.write',
  NOTIFICATIONS_READ: 'notifications.read',
  NOTES_READ: 'notes.read',
  NOTES_WRITE: 'notes.write',
  NOTES_MANAGE: 'notes.manage',
  APPROVALS_READ: 'approvals.read',
  APPROVALS_WRITE: 'approvals.write',
  SUBSCRIPTION_READ: 'subscription.read',
  SUBSCRIPTION_REQUEST: 'subscription.request',
  SUPPORT_CHAT_USE: 'support-chat.use',
} as const;

export type PermissionCode =
  (typeof PermissionsList)[keyof typeof PermissionsList];

// Permissions that the Admin role is never allowed to hold.
// Kept here as the single source of truth so roles.service.ts and
// business.service.ts (default role seeding) stay in sync.
export const ADMIN_FORBIDDEN_PERMISSIONS: PermissionCode[] = [
  PermissionsList.BUSINESS_DELETE,
  PermissionsList.ROLES_CREATE,
  PermissionsList.ROLES_UPDATE,
];

// Explicit permission sets for seeded system roles.
// Defined here so the seeding logic in business.service.ts stays
// maintainable as new permissions are added — no more regex guessing.
// Manager: branch operations — stock, sales oversight, purchasing, suppliers, expenses.
// No user management (Admin+), no role management (System Owner only),
// no business settings write, no subscription access.
export const MANAGER_PERMISSIONS: PermissionCode[] = [
  // Business
  PermissionsList.BUSINESS_READ,
  // Catalog & stock
  PermissionsList.CATALOG_READ,
  PermissionsList.CATALOG_WRITE,
  PermissionsList.STOCK_READ,
  PermissionsList.STOCK_WRITE,
  // Sales (oversight — Cashier handles POS directly)
  PermissionsList.SALES_READ,
  PermissionsList.SALES_WRITE,
  PermissionsList.SALE_CREDIT_CREATE,
  PermissionsList.SALE_CREDIT_SETTLE,
  PermissionsList.RETURN_WITHOUT_RECEIPT,
  // Purchasing & supply chain
  PermissionsList.PURCHASES_READ,
  PermissionsList.PURCHASES_WRITE,
  PermissionsList.SUPPLIERS_READ,
  PermissionsList.SUPPLIERS_WRITE,
  PermissionsList.TRANSFERS_READ,
  PermissionsList.TRANSFERS_WRITE,
  // Expenses
  PermissionsList.EXPENSES_READ,
  PermissionsList.EXPENSES_WRITE,
  // Reporting
  PermissionsList.REPORTS_READ,
  PermissionsList.EXPORTS_WRITE,
  PermissionsList.AUDIT_READ,
  // Attachments
  PermissionsList.ATTACHMENTS_READ,
  PermissionsList.ATTACHMENTS_WRITE,
  // Customers (can view sensitive & export, cannot anonymize)
  PermissionsList.CUSTOMERS_VIEW,
  PermissionsList.CUSTOMERS_CREATE,
  PermissionsList.CUSTOMERS_EDIT,
  PermissionsList.CUSTOMERS_EXPORT,
  PermissionsList.CUSTOMERS_VIEW_SENSITIVE,
  // Price lists & shifts
  PermissionsList.PRICE_LISTS_MANAGE,
  PermissionsList.SHIFTS_OPEN,
  PermissionsList.SHIFTS_CLOSE,
  // Approvals & settings (read only)
  PermissionsList.APPROVALS_READ,
  PermissionsList.APPROVALS_WRITE,
  PermissionsList.SETTINGS_READ,
  // Notifications, notes, search
  PermissionsList.NOTIFICATIONS_READ,
  PermissionsList.NOTES_READ,
  PermissionsList.NOTES_WRITE,
  PermissionsList.NOTES_MANAGE,
  PermissionsList.SEARCH_READ,
];

// Employee: stock & inventory focused. No sales — that is the Cashier's domain.
export const EMPLOYEE_PERMISSIONS: PermissionCode[] = [
  PermissionsList.CATALOG_READ,
  PermissionsList.CATALOG_WRITE,
  PermissionsList.STOCK_READ,
  PermissionsList.STOCK_WRITE,
  PermissionsList.ATTACHMENTS_READ,
  PermissionsList.REPORTS_READ,
  PermissionsList.NOTIFICATIONS_READ,
  PermissionsList.NOTES_READ,
  PermissionsList.NOTES_WRITE,
  PermissionsList.SEARCH_READ,
];

// Cashier: POS & sales focused. No stock write — that is the Employee's domain.
export const CASHIER_PERMISSIONS: PermissionCode[] = [
  PermissionsList.CATALOG_READ,
  PermissionsList.SALES_READ,
  PermissionsList.SALES_WRITE,
  PermissionsList.SALE_CREDIT_CREATE,
  PermissionsList.SALE_CREDIT_SETTLE,
  PermissionsList.CUSTOMERS_VIEW,
  PermissionsList.CUSTOMERS_CREATE,
  PermissionsList.CUSTOMERS_EDIT,
  PermissionsList.SHIFTS_OPEN,
  PermissionsList.SHIFTS_CLOSE,
  PermissionsList.NOTIFICATIONS_READ,
  PermissionsList.NOTES_READ,
  PermissionsList.NOTES_WRITE,
  PermissionsList.SEARCH_READ,
];
