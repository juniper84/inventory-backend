import fs from 'fs';
import path from 'path';
import { PrismaService } from '../src/prisma/prisma.service';

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
  const prisma = new PrismaService();
  const confirm = process.env.CONFIRM === 'YES';
  if (!confirm) {
    console.log('Set CONFIRM=YES to delete Phase C test data.');
    return;
  }

  const businesses = await prisma.business.findMany({
    where: { name: { startsWith: 'Phase C Sales Test ' } },
    select: { id: true, name: true },
  });

  if (businesses.length === 0) {
    console.log('No Phase C test businesses found.');
    return;
  }

  const businessIds = businesses.map((b) => b.id);

  await prisma.saleRefundLine.deleteMany({
    where: { refund: { businessId: { in: businessIds } } },
  });
  await prisma.saleRefund.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.receipt.deleteMany({
    where: { sale: { businessId: { in: businessIds } } },
  });
  await prisma.salePayment.deleteMany({
    where: { sale: { businessId: { in: businessIds } } },
  });
  await prisma.saleLine.deleteMany({
    where: { sale: { businessId: { in: businessIds } } },
  });
  await prisma.sale.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.stockMovement.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.barcode.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.stockSnapshot.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.variant.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.product.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.branch.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.offlineDevice.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.businessUser.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.user.deleteMany({
    where: { email: { startsWith: 'phasec+' } },
  });
  await prisma.subscription.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.businessSettings.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.notification.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.auditLog.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.business.deleteMany({
    where: { id: { in: businessIds } },
  });

  console.log('Phase C test data removed.');
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
