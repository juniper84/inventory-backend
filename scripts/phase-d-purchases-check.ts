import fs from 'fs';
import path from 'path';
import { Prisma, SubscriptionStatus, SubscriptionTier } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { AuditContextStore } from '../src/audit/audit-context';
import { NotificationsService } from '../src/notifications/notifications.service';
import { ApprovalsService } from '../src/approvals/approvals.service';
import { PurchasesService } from '../src/purchases/purchases.service';
import { SubscriptionService } from '../src/subscription/subscription.service';
import { UnitsService } from '../src/units/units.service';
import {
  DEFAULT_APPROVAL_DEFAULTS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_LOCALE_SETTINGS,
  DEFAULT_POS_POLICIES,
  DEFAULT_STOCK_POLICIES,
} from '../src/settings/defaults';
import { hashPassword } from '../src/auth/password';

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
  const purchasesService = new PurchasesService(
    prisma,
    auditService,
    approvalsService,
    notificationsService,
    subscriptionService,
    unitsService,
  );

  const suffix = Date.now();
  const business = await prisma.business.create({
    data: {
      name: `Phase D Purchases Test ${suffix}`,
      status: 'TRIAL',
      defaultLanguage: 'en',
    },
  });

  await prisma.businessSettings.create({
    data: {
      businessId: business.id,
      approvalDefaults: {
        ...DEFAULT_APPROVAL_DEFAULTS,
        purchase: false,
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
      name: 'Phase D Tester',
      email: `phased+${suffix}@local.test`,
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
      name: 'Phase D Branch',
      status: 'ACTIVE',
    },
  });

  const supplier = await prisma.supplier.create({
    data: {
      businessId: business.id,
      name: 'Phase D Supplier',
      status: 'ACTIVE',
    },
  });

  const product = await prisma.product.create({
    data: {
      businessId: business.id,
      name: 'Phase D Product',
      status: 'ACTIVE',
    },
  });

  const variant = await prisma.variant.create({
    data: {
      businessId: business.id,
      productId: product.id,
      name: 'Phase D Variant',
      defaultPrice: new Prisma.Decimal(120),
      minPrice: new Prisma.Decimal(90),
      vatMode: 'INCLUSIVE',
      status: 'ACTIVE',
      trackStock: true,
    },
  });

  const purchaseResult = await purchasesService.createPurchase(
    business.id,
    user.id,
    [],
    {
      branchId: branch.id,
      supplierId: supplier.id,
      lines: [{ variantId: variant.id, quantity: 5, unitCost: 40 }],
    },
  );
  assert(
    purchaseResult && !('approvalRequired' in purchaseResult),
    'Purchase should be created without approval.',
  );

  const purchaseOrderResult = await purchasesService.createPurchaseOrder(
    business.id,
    user.id,
    {
      branchId: branch.id,
      supplierId: supplier.id,
      lines: [{ variantId: variant.id, quantity: 10, unitCost: 35 }],
    },
  );
  assert(
    purchaseOrderResult && !('approvalRequired' in purchaseOrderResult),
    'Purchase order should be created without approval.',
  );

  const purchaseOrderId = (purchaseOrderResult as { id: string }).id;
  const approved = await purchasesService.approvePurchaseOrder(
    business.id,
    purchaseOrderId,
    user.id,
    [],
  );
  assert(
    approved && !('approvalRequired' in approved),
    'Purchase order approval should complete.',
  );

  const receiving = await purchasesService.receive(business.id, user.id, {
    purchaseOrderId,
    lines: [{ variantId: variant.id, quantity: 6, unitCost: 35 }],
    overrideReason: 'Phase D receive',
  });
  assert(receiving?.count === 1, 'Receiving line not created.');

  const receivingLine = await prisma.receivingLine.findFirst({
    where: { purchaseOrderId, variantId: variant.id },
  });
  assert(receivingLine, 'Receiving line not found.');

  const payment = await purchasesService.recordPayment(business.id, user.id, {
    purchaseId: (purchaseResult as { id: string }).id,
    method: 'BANK_TRANSFER',
    amount: 120,
    reference: `PHASED-${suffix}`,
  });
  assert(payment && !('error' in payment), 'Purchase payment failed.');

  const supplierReturn = await purchasesService.createSupplierReturn(
    business.id,
    user.id,
    [],
    {
      branchId: branch.id,
      supplierId: supplier.id,
      purchaseOrderId,
      reason: 'Phase D return',
      lines: [
        {
          variantId: variant.id,
          quantity: 2,
          unitCost: 35,
          receivingLineId: receivingLine?.id,
        },
      ],
    },
  );
  assert(
    supplierReturn && !('approvalRequired' in supplierReturn),
    'Supplier return failed.',
  );

  console.log('\nPhase D purchases check results');
  console.log('Business:', business.id);
  console.log('Purchase:', (purchaseResult as { id: string }).id);
  console.log('Purchase Order:', purchaseOrderId);
  console.log('Receiving line:', receivingLine?.id);
  console.log('Payment:', (payment as { id: string }).id);
  console.log('Supplier Return:', (supplierReturn as { id: string }).id);
  console.log('PASS: Phase D checks OK');
  console.log(
    'Note: Test data remains in the database. Attachments are not exercised here.',
  );

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
