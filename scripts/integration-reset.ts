import { PrismaClient } from '@prisma/client';

type TableRow = { tablename: string };

const prisma = new PrismaClient();

const confirmReset = process.env.CONFIRM_DB_RESET === 'YES';

const run = async () => {
  if (!confirmReset) {
    console.error(
      'Refusing to reset DB. Set CONFIRM_DB_RESET=YES to proceed.',
    );
    process.exit(1);
  }

  const tables = await prisma.$queryRaw<TableRow[]>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> '_prisma_migrations'
  `;

  if (!tables.length) {
    console.log('No tables found to reset.');
    return;
  }

  const tableList = tables
    .map((row) => `"${row.tablename}"`)
    .join(', ');

  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE;`,
  );

  console.log(`Reset ${tables.length} tables.`);
};

run()
  .catch((error) => {
    console.error('Reset failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
