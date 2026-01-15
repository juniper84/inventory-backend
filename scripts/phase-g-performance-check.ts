import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const time = async <T>(label: string, fn: () => Promise<T>) => {
  const start = Date.now();
  const result = await fn();
  const durationMs = Date.now() - start;
  console.log(`${label}: ${durationMs}ms`);
  return result;
};

async function main() {
  const business = await prisma.business.findFirst({
    orderBy: { createdAt: 'desc' },
  });
  if (!business) {
    console.log('No business found to profile.');
    return;
  }

  const businessId = business.id;
  console.log(`Profiling business: ${businessId}`);

  await time('Stock snapshot count', () =>
    prisma.stockSnapshot.count({ where: { businessId } }),
  );
  await time('Recent sales query', () =>
    prisma.sale.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  );
  await time('Reports sales aggregation', () =>
    prisma.sale.groupBy({
      by: ['branchId'],
      where: { businessId, status: 'COMPLETED' },
      _sum: { total: true },
      _count: { id: true },
    }),
  );
  await time('POS catalog lookup', () =>
    prisma.variant.findMany({
      where: { businessId, status: 'ACTIVE' },
      take: 50,
    }),
  );

  console.log('Phase G performance baseline complete.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
