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
  if (process.env.CONFIRM !== 'YES') {
    console.log('Set CONFIRM=YES to remove Phase E test data.');
    return;
  }

  const prisma = new PrismaService();
  const businesses = await prisma.business.findMany({
    where: { name: { startsWith: 'Phase E Reports Test' } },
    select: { id: true },
  });

  if (!businesses.length) {
    console.log('No Phase E test businesses found.');
    return;
  }

  const businessIds = businesses.map((b) => b.id);
  const userIds = (
    await prisma.businessUser.findMany({
      where: { businessId: { in: businessIds } },
      select: { userId: true },
    })
  ).map((row) => row.userId);

  await prisma.notification.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.exportJob.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.saleRefundLine.deleteMany({
    where: { refund: { businessId: { in: businessIds } } },
  });
  await prisma.saleRefund.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.salePayment.deleteMany({
    where: { sale: { businessId: { in: businessIds } } },
  });
  await prisma.saleLine.deleteMany({
    where: { sale: { businessId: { in: businessIds } } },
  });
  await prisma.receipt.deleteMany({
    where: { sale: { businessId: { in: businessIds } } },
  });
  await prisma.saleSettlement.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.sale.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.stockMovement.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.stockSnapshot.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.batch.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.barcode.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.variant.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.product.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.category.updateMany({
    where: { businessId: { in: businessIds } },
    data: { parentId: null },
  });
  await prisma.category.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.supplier.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.customer.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.userRole.deleteMany({
    where: { userId: { in: userIds } },
  });
  await prisma.rolePermission.deleteMany({
    where: { role: { businessId: { in: businessIds } } },
  });
  await prisma.role.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.businessUser.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: userIds } },
  });
  await prisma.businessSettings.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.subscription.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.branch.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.business.updateMany({
    where: { id: { in: businessIds } },
    data: { status: 'DELETED' },
  });

  console.log(
    'Phase E test data removed (audit logs retained; businesses marked DELETED).',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
