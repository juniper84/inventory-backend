import fs from 'fs';
import path from 'path';
import { Prisma, SubscriptionStatus, SubscriptionTier } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { AuditContextStore } from '../src/audit/audit-context';
import { NotificationsService } from '../src/notifications/notifications.service';
import { ApprovalsService } from '../src/approvals/approvals.service';
import { SalesService } from '../src/sales/sales.service';
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
  const salesService = new SalesService(
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
      name: `Phase C Sales Test ${suffix}`,
      status: 'TRIAL',
      defaultLanguage: 'en',
    },
  });

  await prisma.businessSettings.create({
    data: {
      businessId: business.id,
      approvalDefaults: {
        ...DEFAULT_APPROVAL_DEFAULTS,
        refund: false,
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
      name: 'Phase C Tester',
      email: `phasec+${suffix}@local.test`,
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
      name: 'Phase C Branch',
      status: 'ACTIVE',
    },
  });

  const product = await prisma.product.create({
    data: {
      businessId: business.id,
      name: 'Phase C Product',
      status: 'ACTIVE',
    },
  });

  const variant = await prisma.variant.create({
    data: {
      businessId: business.id,
      productId: product.id,
      name: 'Phase C Variant',
      defaultPrice: new Prisma.Decimal(100),
      minPrice: new Prisma.Decimal(80),
      vatMode: 'INCLUSIVE',
      status: 'ACTIVE',
      trackStock: true,
    },
  });

  await prisma.barcode.create({
    data: {
      businessId: business.id,
      variantId: variant.id,
      code: `PHASEC-${suffix}`,
      isActive: true,
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

  const offlineDevice = await prisma.offlineDevice.create({
    data: {
      businessId: business.id,
      userId: user.id,
      deviceName: 'Phase C Device',
      deviceKey: `phasec-${suffix}`,
      lastSeenAt: new Date(),
    },
  });

  const offlineDraft = await salesService.createDraft(
    business.id,
    user.id,
    [],
    [],
    {
      branchId: branch.id,
      isOffline: true,
      offlineDeviceId: offlineDevice.id,
      lines: [
        {
          variantId: variant.id,
          quantity: 1,
          unitPrice: 100,
          vatMode: 'INCLUSIVE',
          vatRate: 18,
        },
      ],
    },
  );

  assert(offlineDraft && (offlineDraft as any).provisional, 'Offline draft not provisional');

  const draft = await salesService.createDraft(
    business.id,
    user.id,
    [],
    [],
    {
      branchId: branch.id,
      cartDiscount: 0,
      lines: [
        {
          variantId: variant.id,
          quantity: 2,
          unitPrice: 100,
          vatMode: 'INCLUSIVE',
          vatRate: 18,
        },
      ],
    },
  );

  const saleId = (draft as any).id ?? (draft as any).sale?.id;
  assert(saleId, 'Sale draft not created.');

  const idempotencyKey = `phasec-${suffix}`;
  const completed = await salesService.completeSale(
    business.id,
    saleId,
    user.id,
    {
      idempotencyKey,
      payments: [{ method: 'CASH', amount: 200 }],
    },
  );

  assert(completed && (completed as any).receipt, 'Sale completion missing receipt.');
  const receiptNumber = (completed as any).receipt?.receiptNumber;
  assert(
    /^[A-Z0-9]+-\d{8}-\d{3}$/.test(receiptNumber),
    'Receipt number format invalid.',
  );

  const completedAgain = await salesService.completeSale(
    business.id,
    saleId,
    user.id,
    {
      idempotencyKey,
      payments: [{ method: 'CASH', amount: 200 }],
    },
  );
  assert(
    (completedAgain as any).receipt?.receiptNumber === receiptNumber,
    'Idempotent completion returned different receipt.',
  );

  const receipts = await salesService.listReceipts(business.id);
  const receiptItems = Array.isArray(receipts)
    ? receipts
    : ((receipts as any).items ?? []);
  assert(receiptItems.length > 0, 'Receipt list empty.');
  const reprint = await salesService.reprintReceipt(
    business.id,
    receiptItems[0].id,
    user.id,
  );
  assert(reprint, 'Receipt reprint failed.');

  const refund = await salesService.refundSale(
    business.id,
    saleId,
    user.id,
    [],
    {
      reason: 'Phase C refund check',
      items: [{ saleLineId: (completed as any).lines[0].id, quantity: 1 }],
    },
  );
  assert(refund && (refund as any).id, 'Refund did not complete.');

  console.log('Phase C sales check results');
  console.log(`Business: ${business.id}`);
  console.log(`Sale: ${saleId}`);
  console.log(`Receipt: ${receiptNumber}`);
  console.log('PASS: Phase C checks OK');
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
