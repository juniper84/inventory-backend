import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  Prisma,
  Permission,
  SubscriptionStatus,
  SubscriptionTier,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { AuditContextStore } from '../src/audit/audit-context';
import { NotificationsService } from '../src/notifications/notifications.service';
import { ApprovalsService } from '../src/approvals/approvals.service';
import { SalesService } from '../src/sales/sales.service';
import { StockService } from '../src/stock/stock.service';
import { PurchasesService } from '../src/purchases/purchases.service';
import { SubscriptionService } from '../src/subscription/subscription.service';
import { RbacService } from '../src/rbac/rbac.service';
import { UnitsService } from '../src/units/units.service';
import {
  DEFAULT_APPROVAL_DEFAULTS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_LOCALE_SETTINGS,
  DEFAULT_POS_POLICIES,
  DEFAULT_STOCK_POLICIES,
} from '../src/settings/defaults';
import { hashPassword } from '../src/auth/password';
import { OfflineService } from '../src/offline/offline.service';
import { SettingsService } from '../src/settings/settings.service';
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

function checksum(payload: Record<string, unknown>) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
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
  const stockService = new StockService(
    prisma,
    auditService,
    approvalsService,
    notificationsService,
    unitsService,
  );
  const purchasesService = new PurchasesService(
    prisma,
    auditService,
    approvalsService,
    notificationsService,
    subscriptionService,
    unitsService,
  );
  const rbacService = new RbacService(prisma);
  const settingsService = new SettingsService(prisma, auditService);
  const offlineService = new OfflineService(
    prisma,
    auditService,
    subscriptionService,
    rbacService,
    settingsService,
    salesService,
    stockService,
    purchasesService,
  );

  const suffix = Date.now();
  const business = await prisma.business.create({
    data: {
      name: `Phase F Offline Test ${suffix}`,
      status: 'TRIAL',
      defaultLanguage: 'en',
    },
  });

  await prisma.businessSettings.create({
    data: {
      businessId: business.id,
      approvalDefaults: {
        ...DEFAULT_APPROVAL_DEFAULTS,
        stockAdjust: false,
      } as Prisma.InputJsonValue,
      notificationDefaults:
        DEFAULT_NOTIFICATION_SETTINGS as Prisma.InputJsonValue,
      stockPolicies: DEFAULT_STOCK_POLICIES as Prisma.InputJsonValue,
      posPolicies: DEFAULT_POS_POLICIES as Prisma.InputJsonValue,
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
        branches: 5,
        products: 5000,
        monthlyTransactions: 5000,
        offline: true,
        offlineDevices: 3,
        storageGb: 5,
      },
    },
  });

  const user = await prisma.user.create({
    data: {
      name: 'Phase F Tester',
      email: `phasef+${suffix}@local.test`,
      passwordHash: hashPassword('TestPass123'),
      status: 'ACTIVE',
    },
  });

  const permissions = Object.values(PermissionsList);
  const permissionRecords: Permission[] = [];
  for (const code of permissions) {
    const record = await prisma.permission.upsert({
      where: { code },
      create: { code },
      update: {},
    });
    permissionRecords.push(record);
  }

  const role = await prisma.role.create({
    data: {
      businessId: business.id,
      name: 'Phase F Owner',
      isSystem: true,
      rolePermissions: {
        create: permissionRecords.map((permission) => ({
          permissionId: permission.id,
        })),
      },
    },
  });

  await prisma.businessUser.create({
    data: {
      businessId: business.id,
      userId: user.id,
      status: 'ACTIVE',
    },
  });

  await prisma.userRole.create({
    data: {
      userId: user.id,
      roleId: role.id,
    },
  });

  const branch = await prisma.branch.create({
    data: {
      businessId: business.id,
      name: 'Phase F Branch',
      status: 'ACTIVE',
    },
  });

  const supplier = await prisma.supplier.create({
    data: {
      businessId: business.id,
      name: 'Phase F Supplier',
      status: 'ACTIVE',
    },
  });

  const product = await prisma.product.create({
    data: {
      businessId: business.id,
      name: 'Phase F Product',
      status: 'ACTIVE',
    },
  });

  const variant = await prisma.variant.create({
    data: {
      businessId: business.id,
      productId: product.id,
      name: 'Phase F Variant',
      defaultPrice: new Prisma.Decimal(100),
      minPrice: new Prisma.Decimal(80),
      vatMode: 'INCLUSIVE',
      status: 'ACTIVE',
      trackStock: true,
    },
  });

  await prisma.stockSnapshot.create({
    data: {
      businessId: business.id,
      branchId: branch.id,
      variantId: variant.id,
      quantity: new Prisma.Decimal(20),
    },
  });

  const device = await offlineService.registerDevice(
    business.id,
    user.id,
    'Phase F Device',
  );

  const salePayload = {
    branchId: branch.id,
    customerId: undefined,
    cartDiscount: 0,
    payments: [{ method: 'CASH', amount: 200 }],
    total: 200,
    lines: [
      {
        variantId: variant.id,
        quantity: 2,
        unitPrice: 100,
        vatMode: 'INCLUSIVE',
        vatRate: 18,
        lineDiscount: 0,
      },
    ],
    idempotencyKey: `sale-${suffix}`,
  };

  const purchasePayload = {
    branchId: branch.id,
    supplierId: supplier.id,
    lines: [{ variantId: variant.id, quantity: 3, unitCost: 40 }],
    idempotencyKey: `purchase-${suffix}`,
  };

  const adjustmentPayload = {
    branchId: branch.id,
    variantId: variant.id,
    quantity: 1,
    type: 'POSITIVE',
    reason: 'Phase F offline adjustment',
    idempotencyKey: `adjust-${suffix}`,
  };

  const { results, cache } = await offlineService.syncActions(
    business.id,
    user.id,
    device.id,
    [
      {
        actionType: 'SALE_COMPLETE',
        payload: salePayload,
        checksum: checksum(salePayload),
        provisionalAt: new Date().toISOString(),
        localAuditId: `audit-sale-${suffix}`,
      },
      {
        actionType: 'PURCHASE_DRAFT',
        payload: purchasePayload,
        checksum: checksum(purchasePayload),
        provisionalAt: new Date().toISOString(),
        localAuditId: `audit-purchase-${suffix}`,
      },
      {
        actionType: 'STOCK_ADJUSTMENT',
        payload: adjustmentPayload,
        checksum: checksum(adjustmentPayload),
        provisionalAt: new Date().toISOString(),
        localAuditId: `audit-adjust-${suffix}`,
      },
    ],
  );

  assert(results.length === 3, 'Expected three offline results.');
  results.forEach((result) =>
    assert(result.status === 'APPLIED', `Offline action ${result.actionType} failed.`),
  );
  assert(cache?.branches, 'Offline cache missing branches.');

  const purchase = await prisma.purchase.findFirst({
    where: { businessId: business.id, status: 'DRAFT' },
  });
  assert(purchase, 'Purchase draft not created.');

  const sale = await prisma.sale.findFirst({
    where: { businessId: business.id },
  });
  assert(sale, 'Sale not created from offline sync.');

  console.log('\nPhase F offline check results');
  console.log('Business:', business.id);
  console.log('Device:', device.id);
  console.log('Sale:', sale?.id);
  console.log('Purchase draft:', purchase?.id);
  console.log('PASS: Phase F offline checks OK');
  console.log('Note: Test data remains in the database.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
