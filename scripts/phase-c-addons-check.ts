import fs from 'fs';
import path from 'path';
import {
  Prisma,
  SubscriptionStatus,
  SubscriptionTier,
  StockMovementType,
  ShiftStatus,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { AuditContextStore } from '../src/audit/audit-context';
import { NotificationsService } from '../src/notifications/notifications.service';
import { ApprovalsService } from '../src/approvals/approvals.service';
import { SalesService } from '../src/sales/sales.service';
import { SubscriptionService } from '../src/subscription/subscription.service';
import { ShiftsService } from '../src/shifts/shifts.service';
import { SearchService } from '../src/search/search.service';
import { UnitsService } from '../src/units/units.service';
import {
  DEFAULT_APPROVAL_DEFAULTS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_LOCALE_SETTINGS,
  DEFAULT_POS_POLICIES,
  DEFAULT_STOCK_POLICIES,
} from '../src/settings/defaults';
import { hashPassword } from '../src/auth/password';
import { PermissionsList } from '../src/rbac/permissions';

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const idx = trimmed.indexOf('=');
    if (idx === -1) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertNotNull<T>(value: T | null | undefined, message: string): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
}

type ApprovalRequired = { approvalRequired: boolean; approvalId?: string };
type SaleWithLines = Prisma.SaleGetPayload<{ include: { lines: true } }>;
type SaleCompleted = Prisma.SaleGetPayload<{
  include: { receipt: true; payments: true; lines: true };
}>;
type SaleRefundWithLines = Prisma.SaleRefundGetPayload<{ include: { lines: true } }>;
type SettlementResult =
  | { settlement: unknown; sale: { outstandingAmount: Prisma.Decimal } }
  | { error: string };
type ShiftResult =
  | { status: ShiftStatus }
  | { approvalRequired: boolean; approvalId?: string };

function isApprovalRequired(value: unknown): value is ApprovalRequired {
  return Boolean(value && typeof value === 'object' && 'approvalRequired' in value);
}

function isSettlementError(value: SettlementResult): value is { error: string } {
  return Boolean(value && typeof value === 'object' && 'error' in value);
}

function extractSale(value: unknown): SaleWithLines {
  if (!value || typeof value !== 'object') {
    throw new Error('Sale draft missing.');
  }
  if ('sale' in value) {
    return (value as { sale: SaleWithLines }).sale;
  }
  return value as SaleWithLines;
}

async function main() {
  loadEnv();
  const prisma = new PrismaService();
  const auditService = new AuditService(prisma, new AuditContextStore());
  const notificationsService = new NotificationsService(prisma, auditService);
  const approvalsService = new ApprovalsService(
    prisma,
    auditService,
    notificationsService,
  );
  const unitsService = new UnitsService(prisma, auditService);
  const configService = new ConfigService();
  const subscriptionService = new SubscriptionService(
    prisma,
    configService,
    auditService,
  );
  const salesService = new SalesService(
    prisma,
    auditService,
    approvalsService,
    notificationsService,
    subscriptionService,
    unitsService,
  );
  const shiftsService = new ShiftsService(prisma, auditService, approvalsService);
  const searchService = new SearchService(prisma);

  const suffix = Date.now();
  const business = await prisma.business.create({
    data: {
      name: `Phase C Addons Test ${suffix}`,
      status: 'TRIAL',
      defaultLanguage: 'en',
    },
  });

  await prisma.businessSettings.create({
    data: {
      businessId: business.id,
      approvalDefaults: DEFAULT_APPROVAL_DEFAULTS as Prisma.InputJsonValue,
      notificationDefaults:
        DEFAULT_NOTIFICATION_SETTINGS as Prisma.InputJsonValue,
      stockPolicies: DEFAULT_STOCK_POLICIES as Prisma.InputJsonValue,
      posPolicies: {
        ...DEFAULT_POS_POLICIES,
        creditEnabled: true,
        shiftTrackingEnabled: true,
        shiftVarianceThreshold: 1000000,
      } as Prisma.InputJsonValue,
      localeSettings: DEFAULT_LOCALE_SETTINGS as Prisma.InputJsonValue,
    },
  });

  await prisma.subscription.create({
    data: {
      businessId: business.id,
      tier: SubscriptionTier.BUSINESS,
      status: SubscriptionStatus.TRIAL,
      trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      limits: {
        users: 10,
        branches: 10,
        products: 10000,
        monthlyTransactions: 10000,
        offline: true,
        offlineDevices: 10,
        storageGb: 10,
      },
    },
  });

  const user = await prisma.user.create({
    data: {
      name: 'Phase C Addons Tester',
      email: `phasec-addons+${suffix}@local.test`,
      passwordHash: hashPassword('TestPass123'),
      status: 'ACTIVE',
    },
  });

  await prisma.businessUser.create({
    data: {
      businessId: business.id,
      userId: user.id,
      status: 'ACTIVE',
    },
  });

  const branch = await prisma.branch.create({
    data: {
      businessId: business.id,
      name: 'Phase C Addons Branch',
      address: 'Main street',
      phone: '255700000001',
      status: 'ACTIVE',
    },
  });

  const customer = await prisma.customer.create({
    data: {
      businessId: business.id,
      name: 'Phase C Customer',
      phone: '255710000000',
      email: `customer+${suffix}@local.test`,
      tin: 'TIN-0001',
      status: 'ACTIVE',
    },
  });

  const priceList = await prisma.priceList.create({
    data: {
      businessId: business.id,
      name: 'Wholesale TZ',
      status: 'ACTIVE',
    },
  });

  await prisma.customer.update({
    where: { id: customer.id },
    data: { priceListId: priceList.id },
  });

  const category = await prisma.category.create({
    data: {
      businessId: business.id,
      name: 'Phase C Category',
      status: 'ACTIVE',
    },
  });

  const product = await prisma.product.create({
    data: {
      businessId: business.id,
      name: 'Phase C Product',
      status: 'ACTIVE',
      categoryId: category.id,
    },
  });

  const variant = await prisma.variant.create({
    data: {
      businessId: business.id,
      productId: product.id,
      name: 'Phase C Variant',
      defaultPrice: new Prisma.Decimal(4000),
      status: 'ACTIVE',
      vatMode: 'INCLUSIVE',
      trackStock: true,
    },
  });

  await prisma.barcode.create({
    data: {
      businessId: business.id,
      variantId: variant.id,
      code: `PHASEC${suffix}`,
      isActive: true,
    },
  });

  await prisma.stockMovement.create({
    data: {
      businessId: business.id,
      branchId: branch.id,
      variantId: variant.id,
      quantity: new Prisma.Decimal(10),
      movementType: StockMovementType.ADJUSTMENT_POSITIVE,
      reason: 'Phase C add-ons test stock seed',
    },
  });

  await prisma.stockSnapshot.create({
    data: {
      businessId: business.id,
      branchId: branch.id,
      variantId: variant.id,
      quantity: new Prisma.Decimal(10),
    },
  });

  await prisma.priceListItem.create({
    data: {
      priceListId: priceList.id,
      variantId: variant.id,
      price: new Prisma.Decimal(3500),
    },
  });

  const shift = await shiftsService.openShift(business.id, user.id, {
    branchId: branch.id,
    openingCash: 100000,
    notes: 'Phase C add-ons shift',
  });

  const draft = (await salesService.createDraft(
    business.id,
    user.id,
    [],
    [PermissionsList.SALE_CREDIT_CREATE, PermissionsList.STOCK_WRITE],
    {
      branchId: branch.id,
      cashierId: user.id,
      customerId: customer.id,
      cartDiscount: 0,
      lines: [
        {
          variantId: variant.id,
          quantity: 2,
        },
      ],
    },
  )) as unknown;

  assertNotNull(draft, 'Sale draft missing.');
  if (isApprovalRequired(draft)) {
    throw new Error('Draft requires approval unexpectedly.');
  }
  const sale = extractSale(draft);
  assert(sale, 'Sale draft missing.');
  assert(sale.customerNameSnapshot === customer.name, 'Customer snapshot missing.');
  assert(sale.shiftId === shift.id, 'Shift not linked on sale.');
  assert(sale.lines?.length === 1, 'Sale line missing.');
  assert(
    Number(sale.lines[0].unitPrice) === 3500,
    'Price list price was not applied.',
  );

  const completed = (await salesService.completeSale(
    business.id,
    sale.id,
    user.id,
    {
      payments: [{ method: 'CASH', amount: 3000 }],
      idempotencyKey: `phasec-addons-${suffix}`,
      creditDueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      userPermissions: [PermissionsList.SALE_CREDIT_CREATE],
    },
  )) as unknown;

  assertNotNull(completed, 'Sale completion failed.');
  if (isApprovalRequired(completed)) {
    throw new Error('Sale completion requires approval unexpectedly.');
  }
  const completedSale = completed as SaleCompleted;
  assert(completedSale.outstandingAmount?.gt(0), 'Outstanding amount missing.');

  const settlement = (await salesService.recordSettlement(
    business.id,
    sale.id,
    user.id,
    { amount: 1000, method: 'CASH' },
  )) as SettlementResult;
  if (!settlement) {
    throw new Error('Settlement failed.');
  }
  if (isSettlementError(settlement)) {
    throw new Error(`Settlement returned error: ${settlement.error}`);
  }
  assert(
    settlement.sale.outstandingAmount.lt(completedSale.outstandingAmount),
    'Settlement did not reduce outstanding balance.',
  );

  const returnResult = (await salesService.returnWithoutReceipt(
    business.id,
    user.id,
    [],
    {
      branchId: branch.id,
      customerId: customer.id,
      reason: 'Damaged item',
      items: [{ variantId: variant.id, quantity: 1, unitPrice: 3500 }],
    },
  )) as unknown;
  assertNotNull(returnResult, 'Return without receipt failed.');
  if (isApprovalRequired(returnResult)) {
    throw new Error('Return without receipt requires approval unexpectedly.');
  }
  const returnRecord = returnResult as SaleRefundWithLines;
  assert(returnRecord.isReturnOnly, 'Return is not marked return-only.');

  const returnMovements = await prisma.stockMovement.findMany({
    where: {
      businessId: business.id,
      branchId: branch.id,
      variantId: variant.id,
      movementType: StockMovementType.RETURN_IN,
    },
  });
  assert(returnMovements.length > 0, 'Return stock movement missing.');

  const searchResults = await searchService.search(
    business.id,
    'Phase C',
  );
  assert(searchResults.products.length > 0, 'Search results missing products.');
  assert(searchResults.customers.length > 0, 'Search results missing customers.');

  const closed = (await shiftsService.closeShift(
    business.id,
    user.id,
    [],
    shift.id,
    { closingCash: 100000 },
  )) as ShiftResult | null;
  assertNotNull(closed, 'Shift close failed.');
  if ('approvalRequired' in closed) {
    throw new Error('Shift close requires approval unexpectedly.');
  }
  assert(closed.status === 'CLOSED', 'Shift did not close.');

  console.log('\nPhase C add-ons check results');
  console.log('Business:', business.id);
  console.log('Customer:', customer.id);
  console.log('Price list:', priceList.id);
  console.log('Sale:', sale.id);
  console.log('Return:', returnRecord.id);
  console.log('PASS: Phase C add-ons checks OK');
  console.log('Note: Test data remains in the database.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    const prisma = new PrismaService();
    await prisma.$disconnect();
  });
