import fs from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { AuditContextStore } from '../src/audit/audit-context';
import { NotificationsService } from '../src/notifications/notifications.service';
import { ApprovalsService } from '../src/approvals/approvals.service';
import { StockService } from '../src/stock/stock.service';
import { TransfersService } from '../src/transfers/transfers.service';
import { UnitsService } from '../src/units/units.service';
import { hashPassword } from '../src/auth/password';
import {
  DEFAULT_APPROVAL_DEFAULTS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_LOCALE_SETTINGS,
  DEFAULT_POS_POLICIES,
  DEFAULT_STOCK_POLICIES,
} from '../src/settings/defaults';

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

async function main() {
  loadEnv();
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set.');
  }

  const prisma = new PrismaService();
  await prisma.$connect();

  const auditService = new AuditService(prisma, new AuditContextStore());
  const notificationsService = new NotificationsService(prisma, auditService);
  const approvalsService = new ApprovalsService(
    prisma,
    auditService,
    notificationsService,
  );
  const unitsService = new UnitsService(prisma, auditService);
  const stockService = new StockService(
    prisma,
    auditService,
    approvalsService,
    notificationsService,
    unitsService,
  );
  const transfersService = new TransfersService(
    prisma,
    auditService,
    approvalsService,
    notificationsService,
  );

  const suffix = Date.now();
  const business = await prisma.business.create({
    data: {
      name: `Phase B Ledger Test ${suffix}`,
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
        transfer: false,
      } as Prisma.InputJsonValue,
      notificationDefaults:
        DEFAULT_NOTIFICATION_SETTINGS as Prisma.InputJsonValue,
      stockPolicies: DEFAULT_STOCK_POLICIES as Prisma.InputJsonValue,
      posPolicies: DEFAULT_POS_POLICIES as Prisma.InputJsonValue,
      localeSettings: DEFAULT_LOCALE_SETTINGS as Prisma.InputJsonValue,
    },
  });

  const user = await prisma.user.create({
    data: {
      name: 'Phase B Tester',
      email: `phaseb+${suffix}@local.test`,
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

  const [branchA, branchB] = await Promise.all([
    prisma.branch.create({
      data: {
        businessId: business.id,
        name: 'Phase B Branch A',
        status: 'ACTIVE',
      },
    }),
    prisma.branch.create({
      data: {
        businessId: business.id,
        name: 'Phase B Branch B',
        status: 'ACTIVE',
      },
    }),
  ]);

  const product = await prisma.product.create({
    data: {
      businessId: business.id,
      name: 'Phase B Product',
      status: 'ACTIVE',
    },
  });

  const variant = await prisma.variant.create({
    data: {
      businessId: business.id,
      productId: product.id,
      name: 'Phase B Variant',
      status: 'ACTIVE',
      trackStock: true,
    },
  });

  const adjustment = await stockService.createAdjustment(
    business.id,
    user.id,
    [],
    {
      branchId: branchA.id,
      variantId: variant.id,
      quantity: 10,
      type: 'POSITIVE',
      reason: 'Phase B adjustment',
    },
  );

  const snapshotAfterAdjustment = await prisma.stockSnapshot.findFirst({
    where: {
      businessId: business.id,
      branchId: branchA.id,
      variantId: variant.id,
    },
  });

  const count = await stockService.createStockCount(
    business.id,
    user.id,
    [],
    {
      branchId: branchA.id,
      variantId: variant.id,
      countedQuantity: 8,
      reason: 'Phase B count',
    },
  );

  const snapshotAfterCount = await prisma.stockSnapshot.findFirst({
    where: {
      businessId: business.id,
      branchId: branchA.id,
      variantId: variant.id,
    },
  });

  const transferResult = await transfersService.create(business.id, user.id, {
    sourceBranchId: branchA.id,
    destinationBranchId: branchB.id,
    items: [{ variantId: variant.id, quantity: 3 }],
  });

  if (!transferResult || 'error' in transferResult) {
    throw new Error(
      `Transfer creation failed: ${
        transferResult && 'error' in transferResult ? transferResult.error : 'null'
      }`,
    );
  }

  const transfer = transferResult;

  await transfersService.approve(business.id, transfer.id, user.id, []);

  await transfersService.receive(business.id, transfer.id, user.id, [
    { transferItemId: transfer.items[0].id, quantity: 2 },
  ]);

  await transfersService.receive(business.id, transfer.id, user.id, [
    { transferItemId: transfer.items[0].id, quantity: 1 },
  ]);

  const finalSnapshots = await prisma.stockSnapshot.findMany({
    where: { businessId: business.id },
    orderBy: { branchId: 'asc' },
  });

  const transferRecord = await prisma.transfer.findFirst({
    where: { id: transfer.id },
    include: { items: true },
  });

  console.log('Phase B ledger check results');
  console.log('Business:', business.id);
  console.log('Adjustment:', adjustment);
  console.log('Snapshot after adjustment:', snapshotAfterAdjustment?.quantity);
  console.log('Stock count:', count);
  console.log('Snapshot after count:', snapshotAfterCount?.quantity);
  console.log('Transfer status:', transferRecord?.status);
  console.log(
    'Transfer received:',
    transferRecord?.items?.[0]?.receivedQuantity?.toString?.() ??
      transferRecord?.items?.[0]?.receivedQuantity,
  );
  console.log('Final snapshots:');
  for (const snap of finalSnapshots) {
    console.log(
      `branch=${snap.branchId} variant=${snap.variantId} qty=${snap.quantity}`,
    );
  }

  const expectedA = 5;
  const expectedB = 3;
  const branchASnap = finalSnapshots.find(
    (snap) => snap.branchId === branchA.id && snap.variantId === variant.id,
  );
  const branchBSnap = finalSnapshots.find(
    (snap) => snap.branchId === branchB.id && snap.variantId === variant.id,
  );

  const pass =
    Number(branchASnap?.quantity ?? 0) === expectedA &&
    Number(branchBSnap?.quantity ?? 0) === expectedB &&
    transferRecord?.status === 'COMPLETED';

  console.log(pass ? 'PASS: Ledger checks OK' : 'FAIL: Ledger checks mismatch');
  console.log('Note: Test data remains in the database.');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
