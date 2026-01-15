import fs from 'fs';
import path from 'path';
import { Prisma, PrismaClient, RecordStatus, SaleStatus, VatMode, PaymentMethod, SubscriptionTier, SubscriptionStatus } from '@prisma/client';
import {
  DEFAULT_APPROVAL_DEFAULTS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_STOCK_POLICIES,
  DEFAULT_POS_POLICIES,
  DEFAULT_LOCALE_SETTINGS,
} from '../src/settings/defaults';

const prisma = new PrismaClient();

const time = async <T>(label: string, fn: () => Promise<T>) => {
  const start = Date.now();
  const result = await fn();
  const durationMs = Date.now() - start;
  console.log(`${label}: ${durationMs}ms`);
  return result;
};

const loadEnv = () => {
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
};

const readNumber = (key: string, fallback: number) => {
  const raw = process.env[key];
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

const batchInsert = async <T>(
  label: string,
  total: number,
  batchSize: number,
  build: (start: number, end: number) => Promise<T>,
) => {
  for (let start = 0; start < total; start += batchSize) {
    const end = Math.min(start + batchSize, total);
    await time(`${label} ${start + 1}-${end}`, () => build(start, end));
  }
};

async function main() {
  loadEnv();
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set.');
  }

  const productCount = readNumber('PHASE_G_PRODUCTS', 5000);
  const salesCount = readNumber('PHASE_G_SALES', 1000);
  const batchSize = readNumber('PHASE_G_BATCH', 250);
  const saleConcurrency = readNumber('PHASE_G_CONCURRENCY', 12);

  const suffix = Date.now();
  const business = await prisma.business.create({
    data: {
      name: `Phase G Scale Test ${suffix}`,
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
        users: 50,
        branches: 10,
        products: productCount + 500,
        monthlyTransactions: salesCount + 1000,
        offline: true,
        offlineDevices: 10,
        storageGb: 25,
      },
    },
  });

  const user = await prisma.user.create({
    data: {
      name: 'Phase G Tester',
      email: `phaseg+${suffix}@local.test`,
      passwordHash: 'phaseg',
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
      name: 'Phase G Branch',
      status: 'ACTIVE',
    },
  });

  const defaultUnit =
    (await prisma.unit.findFirst({
      where: {
        OR: [
          { businessId: business.id, code: 'piece' },
          { businessId: null, code: 'piece' },
        ],
      },
    })) ??
    (await prisma.unit.create({
      data: {
        businessId: null,
        code: 'piece',
        label: 'Piece',
        unitType: 'COUNT',
      },
    }));

  await batchInsert('Products', productCount, batchSize, async (start, end) => {
    const data = Array.from({ length: end - start }).map((_, index) => ({
      businessId: business.id,
      name: `Phase G Product ${suffix} #${start + index + 1}`,
      status: RecordStatus.ACTIVE,
    }));
    await prisma.product.createMany({ data, skipDuplicates: true });
  });

  const products = await prisma.product.findMany({
    where: {
      businessId: business.id,
      name: { startsWith: `Phase G Product ${suffix}` },
    },
    select: { id: true, name: true },
  });

  await batchInsert('Variants', products.length, batchSize, async (start, end) => {
    const data = products.slice(start, end).map((product, index) => ({
      businessId: business.id,
      productId: product.id,
      name: `Phase G Variant ${suffix} #${start + index + 1}`,
      status: RecordStatus.ACTIVE,
      trackStock: true,
      defaultPrice: new Prisma.Decimal(1000),
      baseUnitId: defaultUnit.id,
      sellUnitId: defaultUnit.id,
      conversionFactor: new Prisma.Decimal(1),
    }));
    await prisma.variant.createMany({ data, skipDuplicates: true });
  });

  const variants = await prisma.variant.findMany({
    where: { businessId: business.id },
    select: { id: true, name: true, product: { select: { name: true } } },
  });

  await batchInsert('Stock snapshots', variants.length, batchSize, async (start, end) => {
    const data = variants.slice(start, end).map((variant) => ({
      businessId: business.id,
      branchId: branch.id,
      variantId: variant.id,
      quantity: new Prisma.Decimal(100),
    }));
    await prisma.stockSnapshot.createMany({ data, skipDuplicates: true });
  });

  const unitPrice = new Prisma.Decimal(1000);
  const vatRate = new Prisma.Decimal(18);
  const vatDivisor = new Prisma.Decimal(118);
  const lineTotal = new Prisma.Decimal(2000);
  const vatAmount = lineTotal.mul(vatRate).div(vatDivisor);
  const subtotal = lineTotal.sub(vatAmount);

  console.log(`Creating ${salesCount} sales...`);
  for (let i = 0; i < salesCount; i += saleConcurrency) {
    const batch: Prisma.PrismaPromise<unknown>[] = [];
    for (let j = 0; j < saleConcurrency && i + j < salesCount; j += 1) {
      const variant = variants[(i + j) % variants.length];
      batch.push(
        prisma.sale.create({
          data: {
            businessId: business.id,
            branchId: branch.id,
            cashierId: user.id,
            status: SaleStatus.COMPLETED,
            subtotal,
            discountTotal: new Prisma.Decimal(0),
            vatTotal: vatAmount,
            total: lineTotal,
            cartDiscount: new Prisma.Decimal(0),
            paidAmount: lineTotal,
            outstandingAmount: new Prisma.Decimal(0),
            completedAt: new Date(),
            saleType: 'SALE',
            lines: {
              create: [
                {
                  variantId: variant.id,
                  quantity: new Prisma.Decimal(2),
                  unitPrice,
                  vatMode: VatMode.INCLUSIVE,
                  vatRate,
                  vatAmount,
                  lineTotal,
                  lineDiscount: new Prisma.Decimal(0),
                  productName: variant.product?.name ?? 'Product',
                  variantName: variant.name,
                  unitId: defaultUnit.id,
                  unitFactor: new Prisma.Decimal(1),
                },
              ],
            },
            payments: {
              create: [
                {
                  method: PaymentMethod.CASH,
                  amount: lineTotal,
                  methodLabel: 'Cash',
                },
              ],
            },
          },
        }),
      );
    }
    await time(`Sales batch ${i + 1}-${Math.min(i + saleConcurrency, salesCount)}`, () =>
      Promise.all(batch),
    );
  }

  console.log('Running performance queries...');
  await time('Stock snapshot count', () =>
    prisma.stockSnapshot.count({ where: { businessId: business.id } }),
  );
  await time('Variant search', () =>
    prisma.variant.findMany({
      where: { businessId: business.id, status: RecordStatus.ACTIVE },
      take: 50,
    }),
  );
  await time('Recent sales', () =>
    prisma.sale.findMany({
      where: { businessId: business.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  );
  await time('Sales aggregation by branch', () =>
    prisma.sale.groupBy({
      by: ['branchId'],
      where: { businessId: business.id, status: SaleStatus.COMPLETED },
      _sum: { total: true },
      _count: { id: true },
    }),
  );

  console.log('Phase G scale check results');
  console.log('Business:', business.id);
  console.log('Branch:', branch.id);
  console.log('Products:', products.length);
  console.log('Variants:', variants.length);
  console.log('Sales:', salesCount);
  console.log('PASS: Phase G scale check complete');
  console.log('Note: Test data remains in the database.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
