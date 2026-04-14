/**
 * Demo data seeder for the marketing-site screenshots.
 *
 * Usage:
 *   DEMO_BUSINESS_ID=49a5b87c-52b0-4661-9918-71f0e40e6059 DEMO_CONFIRM=YES \
 *     npx ts-node scripts/seed-demo.ts
 *
 * Safety:
 *  - Refuses to run unless the Business.name contains "demo" (case-insensitive).
 *  - Refuses to run unless DEMO_CONFIRM=YES is set.
 *  - Wipes only the transactional + catalog data of the given business, then reseeds.
 *  - Never touches any other business in the database.
 */

import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const BUSINESS_ID = process.env.DEMO_BUSINESS_ID;
const CONFIRM = process.env.DEMO_CONFIRM;

type Rng = () => number;
function mulberry32(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand: Rng = mulberry32(2026041401);
const randInt = (min: number, max: number) =>
  Math.floor(rand() * (max - min + 1)) + min;
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];

type VariantSpec = {
  sku: string;
  name: string;
  cost: number;
  price: number;
};
type ProductSpec = {
  name: string;
  category: string;
  variants: VariantSpec[];
};

const CATEGORIES = [
  'Groceries',
  'Drinks',
  'Household',
  'Airtime & Electronics',
  'Stationery',
  'Personal Care',
] as const;

const PRODUCTS: ProductSpec[] = [
  {
    name: 'Sugar',
    category: 'Groceries',
    variants: [
      { sku: 'KILDEMO-SUGAR-1KG', name: '1 kg', cost: 2800, price: 3500 },
      { sku: 'KILDEMO-SUGAR-2KG', name: '2 kg', cost: 5500, price: 6800 },
      { sku: 'KILDEMO-SUGAR-5KG', name: '5 kg', cost: 13500, price: 16500 },
    ],
  },
  {
    name: 'Rice',
    category: 'Groceries',
    variants: [
      { sku: 'KILDEMO-RICE-2KG', name: '2 kg', cost: 6500, price: 8500 },
      { sku: 'KILDEMO-RICE-5KG', name: '5 kg', cost: 15500, price: 19500 },
      { sku: 'KILDEMO-RICE-25KG', name: '25 kg sack', cost: 75000, price: 92000 },
    ],
  },
  {
    name: 'Cooking Oil',
    category: 'Groceries',
    variants: [
      { sku: 'KILDEMO-OIL-1L', name: '1 L bottle', cost: 4200, price: 5500 },
      { sku: 'KILDEMO-OIL-5L', name: '5 L jerry', cost: 20000, price: 24500 },
      { sku: 'KILDEMO-OIL-20L', name: '20 L drum', cost: 78000, price: 94000 },
    ],
  },
  {
    name: 'Maize Flour',
    category: 'Groceries',
    variants: [
      { sku: 'KILDEMO-FLOUR-2KG', name: '2 kg', cost: 3200, price: 4200 },
      { sku: 'KILDEMO-FLOUR-10KG', name: '10 kg', cost: 15000, price: 18500 },
    ],
  },
  {
    name: 'Salt',
    category: 'Groceries',
    variants: [
      { sku: 'KILDEMO-SALT-500G', name: '500 g', cost: 600, price: 900 },
      { sku: 'KILDEMO-SALT-1KG', name: '1 kg', cost: 1100, price: 1600 },
    ],
  },
  {
    name: 'Tea Leaves',
    category: 'Groceries',
    variants: [
      { sku: 'KILDEMO-TEA-250G', name: '250 g', cost: 1800, price: 2500 },
      { sku: 'KILDEMO-TEA-500G', name: '500 g', cost: 3400, price: 4500 },
    ],
  },
  {
    name: 'Bottled Water',
    category: 'Drinks',
    variants: [
      { sku: 'KILDEMO-WATER-500ML', name: '500 ml', cost: 300, price: 500 },
      { sku: 'KILDEMO-WATER-1L', name: '1 L', cost: 600, price: 1000 },
      { sku: 'KILDEMO-WATER-5L', name: '5 L', cost: 2200, price: 3000 },
    ],
  },
  {
    name: 'Soda',
    category: 'Drinks',
    variants: [
      { sku: 'KILDEMO-SODA-300ML', name: '300 ml', cost: 900, price: 1500 },
      { sku: 'KILDEMO-SODA-500ML', name: '500 ml', cost: 1200, price: 2000 },
      { sku: 'KILDEMO-SODA-1L', name: '1 L', cost: 2200, price: 3200 },
    ],
  },
  {
    name: 'Bar Soap',
    category: 'Household',
    variants: [
      { sku: 'KILDEMO-SOAP-BLUE', name: 'Blue bar', cost: 900, price: 1500 },
      { sku: 'KILDEMO-SOAP-WHITE', name: 'White bar', cost: 900, price: 1500 },
    ],
  },
  {
    name: 'Detergent',
    category: 'Household',
    variants: [
      { sku: 'KILDEMO-DET-500G', name: '500 g pack', cost: 2000, price: 2800 },
      { sku: 'KILDEMO-DET-1KG', name: '1 kg pack', cost: 3800, price: 5200 },
    ],
  },
  {
    name: 'Toothpaste',
    category: 'Personal Care',
    variants: [
      { sku: 'KILDEMO-TP-50ML', name: '50 ml', cost: 1500, price: 2200 },
      { sku: 'KILDEMO-TP-100ML', name: '100 ml', cost: 2500, price: 3500 },
    ],
  },
  {
    name: 'Toilet Paper',
    category: 'Household',
    variants: [
      { sku: 'KILDEMO-TP-SINGLE', name: 'Single roll', cost: 700, price: 1200 },
      { sku: 'KILDEMO-TP-4PACK', name: '4-pack', cost: 2600, price: 3800 },
    ],
  },
  {
    name: 'Phone Charger',
    category: 'Airtime & Electronics',
    variants: [
      { sku: 'KILDEMO-CHARGER-USBC', name: 'USB-C', cost: 6000, price: 9500 },
      { sku: 'KILDEMO-CHARGER-MICRO', name: 'Micro-USB', cost: 5000, price: 8000 },
    ],
  },
  {
    name: 'Airtime Voucher',
    category: 'Airtime & Electronics',
    variants: [
      { sku: 'KILDEMO-AIRTIME-1K', name: '1,000 TZS', cost: 950, price: 1000 },
      { sku: 'KILDEMO-AIRTIME-5K', name: '5,000 TZS', cost: 4800, price: 5000 },
      { sku: 'KILDEMO-AIRTIME-10K', name: '10,000 TZS', cost: 9700, price: 10000 },
    ],
  },
  {
    name: 'Batteries',
    category: 'Airtime & Electronics',
    variants: [
      { sku: 'KILDEMO-BATT-AA', name: 'AA pack of 4', cost: 1800, price: 2800 },
      { sku: 'KILDEMO-BATT-AAA', name: 'AAA pack of 4', cost: 1800, price: 2800 },
    ],
  },
  {
    name: 'Notebook',
    category: 'Stationery',
    variants: [
      { sku: 'KILDEMO-NB-A4', name: 'A4 96 pages', cost: 1200, price: 2000 },
      { sku: 'KILDEMO-NB-A5', name: 'A5 80 pages', cost: 900, price: 1500 },
    ],
  },
  {
    name: 'Pen',
    category: 'Stationery',
    variants: [
      { sku: 'KILDEMO-PEN-BLUE', name: 'Blue', cost: 200, price: 500 },
      { sku: 'KILDEMO-PEN-BLACK', name: 'Black', cost: 200, price: 500 },
      { sku: 'KILDEMO-PEN-RED', name: 'Red', cost: 200, price: 500 },
    ],
  },
  {
    name: 'Biscuits',
    category: 'Groceries',
    variants: [
      { sku: 'KILDEMO-BISC-SMALL', name: 'Small pack', cost: 600, price: 1000 },
      { sku: 'KILDEMO-BISC-LARGE', name: 'Large pack', cost: 1500, price: 2500 },
    ],
  },
];

const SUPPLIER_NAMES = [
  'Msasani Wholesale Co.',
  'Dar Distributors Ltd',
  'Kariakoo Supply Partners',
  'Coastal Goods Agency',
  'Moshi Trade Link',
];

const CUSTOMER_NAMES = [
  'Amina Hassan',
  'John Mwakalinga',
  'Grace Kimaro',
  'Peter Mushi',
  'Fatma Juma',
  'Daniel Mollel',
  'Rehema Said',
  'Joseph Mkapa',
  'Neema Lema',
  'Samuel Kibona',
  'Halima Omari',
  'Michael Swai',
  'Zainab Ally',
  'Emmanuel Kimathi',
  'Mariam Rajabu',
];

const PAYMENT_METHODS = ['CASH', 'MOBILE_MONEY', 'CASH', 'CASH', 'MOBILE_MONEY', 'CARD'] as const;

async function assertSafeToRun() {
  if (!BUSINESS_ID) {
    throw new Error('Missing DEMO_BUSINESS_ID env var.');
  }
  if (CONFIRM !== 'YES') {
    throw new Error(
      'Refusing to run without DEMO_CONFIRM=YES. This script wipes transactional data of the target business.',
    );
  }
  const business = await prisma.business.findUnique({
    where: { id: BUSINESS_ID },
    select: { id: true, name: true },
  });
  if (!business) {
    throw new Error(`Business ${BUSINESS_ID} not found.`);
  }
  if (!/demo/i.test(business.name)) {
    throw new Error(
      `Business name "${business.name}" does not contain "demo" — refusing to seed non-demo business.`,
    );
  }
  return business;
}

async function wipeBusinessData(businessId: string) {
  console.log('→ Wiping prior data for business...');
  // Delete in FK-safe order
  await prisma.$transaction(async (tx) => {
    await tx.salePayment.deleteMany({ where: { sale: { businessId } } });
    await tx.receipt.deleteMany({ where: { businessId } });
    await tx.saleLine.deleteMany({ where: { sale: { businessId } } });
    await tx.sale.deleteMany({ where: { businessId } });

    await tx.purchasePayment.deleteMany({ where: { businessId } });
    await tx.receivingLine.deleteMany({
      where: { purchase: { businessId } },
    });
    await tx.purchaseLine.deleteMany({ where: { purchase: { businessId } } });
    await tx.purchase.deleteMany({ where: { businessId } });

    await tx.stockMovement.deleteMany({ where: { businessId } });
    await tx.stockSnapshot.deleteMany({ where: { businessId } });
    await tx.batch.deleteMany({ where: { businessId } });

    await tx.reorderPoint.deleteMany({ where: { businessId } });
    await tx.branchVariantAvailability.deleteMany({ where: { businessId } });

    await tx.barcode.deleteMany({ where: { businessId } });
    await tx.variant.deleteMany({ where: { businessId } });
    await tx.productImage.deleteMany({ where: { businessId } });
    await tx.product.deleteMany({ where: { businessId } });
    await tx.category.deleteMany({ where: { businessId } });

    await tx.customer.deleteMany({ where: { businessId } });
    await tx.supplier.deleteMany({ where: { businessId } });
  });
}

async function ensureBranch(businessId: string) {
  const existing = await prisma.branch.findFirst({
    where: { businessId },
    orderBy: { isDefault: 'desc' },
  });
  if (existing) return existing;
  return prisma.branch.create({
    data: {
      businessId,
      name: 'Main Store',
      isDefault: true,
    },
  });
}

async function ensureUnit(businessId: string) {
  const existing = await prisma.unit.findFirst({
    where: { businessId, code: 'pcs' },
  });
  if (existing) return existing;
  return prisma.unit.create({
    data: {
      businessId,
      code: 'pcs',
      label: 'Pieces',
      unitType: 'COUNT',
    },
  });
}

async function seedCategories(businessId: string) {
  const map = new Map<string, string>();
  for (const name of CATEGORIES) {
    const cat = await prisma.category.create({
      data: { businessId, name },
    });
    map.set(name, cat.id);
  }
  return map;
}

async function seedProducts(
  businessId: string,
  categoryMap: Map<string, string>,
  unitId: string,
) {
  const variantIds: { id: string; cost: number; price: number; name: string; sku: string }[] = [];
  for (const spec of PRODUCTS) {
    const product = await prisma.product.create({
      data: {
        businessId,
        name: spec.name,
        categoryId: categoryMap.get(spec.category) ?? null,
      },
    });
    for (const v of spec.variants) {
      const variant = await prisma.variant.create({
        data: {
          businessId,
          productId: product.id,
          name: v.name,
          sku: v.sku,
          defaultCost: new Prisma.Decimal(v.cost),
          defaultPrice: new Prisma.Decimal(v.price),
          baseUnitId: unitId,
          sellUnitId: unitId,
          conversionFactor: new Prisma.Decimal(1),
          vatMode: 'INCLUSIVE',
        },
      });
      const barcodeBase = 6000000000000 + variantIds.length;
      await prisma.barcode.create({
        data: {
          businessId,
          variantId: variant.id,
          code: String(barcodeBase),
        },
      });
      variantIds.push({
        id: variant.id,
        cost: v.cost,
        price: v.price,
        name: `${spec.name} — ${v.name}`,
        sku: v.sku,
      });
    }
  }
  return variantIds;
}

async function seedSuppliers(businessId: string) {
  const suppliers: { id: string; name: string }[] = [];
  for (let i = 0; i < SUPPLIER_NAMES.length; i += 1) {
    const s = await prisma.supplier.create({
      data: {
        businessId,
        name: SUPPLIER_NAMES[i],
        phone: `+255 000 ${String(100 + i).padStart(3, '0')} ${String(
          randInt(100, 999),
        )}`,
        email: `supplier${i + 1}@kilidemo.local`,
        leadTimeDays: randInt(3, 10),
      },
    });
    suppliers.push(s);
  }
  return suppliers;
}

async function seedCustomers(businessId: string) {
  const customers: { id: string; name: string; phone: string | null; email: string | null }[] = [];
  for (let i = 0; i < CUSTOMER_NAMES.length; i += 1) {
    const c = await prisma.customer.create({
      data: {
        businessId,
        name: CUSTOMER_NAMES[i],
        phone: `+255 000 ${String(200 + i).padStart(3, '0')} ${String(
          randInt(100, 999),
        )}`,
        email: `customer${i + 1}@kilidemo.local`,
      },
    });
    customers.push(c);
  }
  return customers;
}

type VariantRef = Awaited<ReturnType<typeof seedProducts>>[number];

async function seedOpeningStock(
  businessId: string,
  branchId: string,
  variants: VariantRef[],
) {
  const openingAt = new Date();
  openingAt.setDate(openingAt.getDate() - 35);
  for (const v of variants) {
    const qty = randInt(40, 300);
    await prisma.stockMovement.create({
      data: {
        businessId,
        branchId,
        variantId: v.id,
        quantity: new Prisma.Decimal(qty),
        movementType: 'OPENING_BALANCE',
        reason: 'Opening balance (demo seed)',
        createdAt: openingAt,
      },
    });
    await prisma.stockSnapshot.upsert({
      where: {
        businessId_branchId_variantId: { businessId, branchId, variantId: v.id },
      },
      update: { quantity: new Prisma.Decimal(qty) },
      create: {
        businessId,
        branchId,
        variantId: v.id,
        quantity: new Prisma.Decimal(qty),
      },
    });
  }
}

async function adjustSnapshot(
  businessId: string,
  branchId: string,
  variantId: string,
  delta: number,
) {
  await prisma.stockSnapshot.upsert({
    where: {
      businessId_branchId_variantId: { businessId, branchId, variantId },
    },
    update: { quantity: { increment: new Prisma.Decimal(delta) } },
    create: {
      businessId,
      branchId,
      variantId,
      quantity: new Prisma.Decimal(Math.max(0, delta)),
    },
  });
}

async function seedPurchases(
  businessId: string,
  branchId: string,
  variants: VariantRef[],
  suppliers: { id: string }[],
) {
  const now = Date.now();
  const count = 15;
  let purchaseSeq = 1;
  for (let i = 0; i < count; i += 1) {
    const daysAgo = randInt(1, 28);
    const when = new Date(now - daysAgo * 86_400_000);
    const supplier = pick(suppliers);
    const lineCount = randInt(3, 6);
    const picks = new Set<number>();
    while (picks.size < lineCount) picks.add(randInt(0, variants.length - 1));
    const lines = [...picks].map((idx) => {
      const v = variants[idx];
      const qty = randInt(20, 120);
      return { variant: v, qty };
    });
    const total = lines.reduce((sum, l) => sum + l.qty * l.variant.cost, 0);
    const purchase = await prisma.purchase.create({
      data: {
        businessId,
        branchId,
        supplierId: supplier.id,
        status: 'FULLY_RECEIVED',
        total: new Prisma.Decimal(total),
        referenceNumber: `PUR-${String(purchaseSeq).padStart(4, '0')}`,
        createdAt: when,
        updatedAt: when,
      },
    });
    purchaseSeq += 1;
    for (const l of lines) {
      await prisma.purchaseLine.create({
        data: {
          purchaseId: purchase.id,
          variantId: l.variant.id,
          quantity: new Prisma.Decimal(l.qty),
          unitCost: new Prisma.Decimal(l.variant.cost),
        },
      });
      await prisma.receivingLine.create({
        data: {
          purchaseId: purchase.id,
          variantId: l.variant.id,
          quantity: new Prisma.Decimal(l.qty),
          unitCost: new Prisma.Decimal(l.variant.cost),
          receivedAt: when,
        },
      });
      await prisma.stockMovement.create({
        data: {
          businessId,
          branchId,
          variantId: l.variant.id,
          quantity: new Prisma.Decimal(l.qty),
          movementType: 'PURCHASE_IN',
          reason: `Purchase ${purchase.referenceNumber}`,
          createdAt: when,
        },
      });
      await adjustSnapshot(businessId, branchId, l.variant.id, l.qty);
    }
  }
}

async function seedSales(
  businessId: string,
  branchId: string,
  variants: VariantRef[],
  customers: { id: string; name: string; phone: string | null }[],
) {
  const dayStart = new Date();
  dayStart.setDate(dayStart.getDate() - 30);
  dayStart.setHours(0, 0, 0, 0);

  let saleSeq = 1;
  let receiptSeq = 1;
  const today = new Date();

  for (let day = 0; day < 31; day += 1) {
    const date = new Date(dayStart);
    date.setDate(date.getDate() + day);
    if (date > today) break;
    const weekday = date.getDay();
    const isWeekend = weekday === 0 || weekday === 6;
    const base = randInt(4, 8);
    const count = isWeekend ? base + randInt(2, 4) : base;

    for (let s = 0; s < count; s += 1) {
      const saleTime = new Date(date);
      saleTime.setHours(randInt(8, 20), randInt(0, 59), randInt(0, 59));

      const lineCount = randInt(1, 4);
      const lineIdxs = new Set<number>();
      while (lineIdxs.size < lineCount)
        lineIdxs.add(randInt(0, variants.length - 1));
      const lines = [...lineIdxs].map((idx) => {
        const v = variants[idx];
        const qty = randInt(1, 4);
        const lineTotal = qty * v.price;
        return { v, qty, lineTotal };
      });
      const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
      const total = subtotal;

      const customerPick = rand() < 0.55 ? pick(customers) : null;
      const method = pick(PAYMENT_METHODS);
      const yyyymmdd = `${saleTime.getFullYear()}${String(
        saleTime.getMonth() + 1,
      ).padStart(2, '0')}${String(saleTime.getDate()).padStart(2, '0')}`;

      const sale = await prisma.sale.create({
        data: {
          businessId,
          branchId,
          customerId: customerPick?.id ?? null,
          customerNameSnapshot: customerPick?.name ?? null,
          customerPhoneSnapshot: customerPick?.phone ?? null,
          status: 'COMPLETED',
          subtotal: new Prisma.Decimal(subtotal),
          discountTotal: new Prisma.Decimal(0),
          vatTotal: new Prisma.Decimal(0),
          cartDiscount: new Prisma.Decimal(0),
          total: new Prisma.Decimal(total),
          paidAmount: new Prisma.Decimal(total),
          outstandingAmount: new Prisma.Decimal(0),
          saleType: 'SALE',
          referenceNumber: `SAL-${String(saleSeq).padStart(4, '0')}`,
          createdAt: saleTime,
          completedAt: saleTime,
        },
      });
      saleSeq += 1;

      for (const l of lines) {
        await prisma.saleLine.create({
          data: {
            saleId: sale.id,
            variantId: l.v.id,
            quantity: new Prisma.Decimal(l.qty),
            unitPrice: new Prisma.Decimal(l.v.price),
            vatMode: 'INCLUSIVE',
            vatRate: new Prisma.Decimal(0),
            vatAmount: new Prisma.Decimal(0),
            lineTotal: new Prisma.Decimal(l.lineTotal),
            lineDiscount: new Prisma.Decimal(0),
            productName: l.v.name.split(' — ')[0],
            variantName: l.v.name.split(' — ')[1] ?? 'Default',
            skuSnapshot: l.v.sku,
            unitCost: new Prisma.Decimal(l.v.cost),
          },
        });
        await prisma.stockMovement.create({
          data: {
            businessId,
            branchId,
            variantId: l.v.id,
            quantity: new Prisma.Decimal(-l.qty),
            movementType: 'SALE_OUT',
            reason: `Sale ${sale.referenceNumber}`,
            createdAt: saleTime,
          },
        });
        await adjustSnapshot(businessId, branchId, l.v.id, -l.qty);
      }

      await prisma.salePayment.create({
        data: {
          saleId: sale.id,
          method,
          amount: new Prisma.Decimal(total),
        },
      });

      await prisma.receipt.create({
        data: {
          businessId,
          saleId: sale.id,
          receiptNumber: `KIL-${yyyymmdd}-${String(receiptSeq).padStart(4, '0')}`,
          issuedAt: saleTime,
        },
      });
      receiptSeq += 1;
    }
  }
  return saleSeq - 1;
}

async function seedReorderPoints(
  businessId: string,
  branchId: string,
  variants: VariantRef[],
) {
  // Pick ~10 variants to have a reorder point. For 2–3 of them, also push
  // the snapshot below the reorder point so low-stock alerts show up.
  const picks = [...variants].sort(() => rand() - 0.5).slice(0, 10);
  for (let i = 0; i < picks.length; i += 1) {
    const v = picks[i];
    const min = randInt(15, 40);
    const reorder = min + randInt(20, 50);
    await prisma.reorderPoint.create({
      data: {
        businessId,
        branchId,
        variantId: v.id,
        minQuantity: new Prisma.Decimal(min),
        reorderQuantity: new Prisma.Decimal(reorder),
      },
    });
    if (i < 3) {
      await prisma.stockSnapshot.update({
        where: {
          businessId_branchId_variantId: {
            businessId,
            branchId,
            variantId: v.id,
          },
        },
        data: { quantity: new Prisma.Decimal(randInt(2, min - 1)) },
      });
    }
  }
}

async function main() {
  const business = await assertSafeToRun();
  console.log(`✓ Target business: ${business.name} (${business.id})`);

  await wipeBusinessData(business.id);

  const branch = await ensureBranch(business.id);
  const unit = await ensureUnit(business.id);
  console.log(`✓ Branch: ${branch.name}`);

  const categoryMap = await seedCategories(business.id);
  console.log(`✓ Categories: ${categoryMap.size}`);

  const variants = await seedProducts(business.id, categoryMap, unit.id);
  console.log(`✓ Products: ${PRODUCTS.length}, variants: ${variants.length}`);

  const suppliers = await seedSuppliers(business.id);
  console.log(`✓ Suppliers: ${suppliers.length}`);

  const customers = await seedCustomers(business.id);
  console.log(`✓ Customers: ${customers.length}`);

  await seedOpeningStock(business.id, branch.id, variants);
  console.log('✓ Opening stock movements + snapshots');

  await seedPurchases(business.id, branch.id, variants, suppliers);
  console.log('✓ Purchases seeded');

  const saleCount = await seedSales(
    business.id,
    branch.id,
    variants,
    customers.map((c) => ({ id: c.id, name: c.name, phone: c.phone })),
  );
  console.log(`✓ Sales seeded: ${saleCount}`);

  await seedReorderPoints(business.id, branch.id, variants);
  console.log('✓ Reorder points (with a few low-stock)');

  console.log('\nDone. Log in as the demo user to review and take screenshots.');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
