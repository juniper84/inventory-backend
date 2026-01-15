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
    console.log('Set CONFIRM=YES to remove Phase D test data.');
    return;
  }

  const prisma = new PrismaService();
  const businesses = await prisma.business.findMany({
    where: { name: { startsWith: 'Phase D Purchases Test' } },
    select: { id: true },
  });

  if (!businesses.length) {
    console.log('No Phase D test businesses found.');
    return;
  }

  const businessIds = businesses.map((b) => b.id);
  const supplierReturns = await prisma.supplierReturn.findMany({
    where: { businessId: { in: businessIds } },
    select: { id: true },
  });
  const supplierReturnIds = supplierReturns.map((sr) => sr.id);

  await prisma.notification.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.supplierReturnLine.deleteMany({
    where: { supplierReturnId: { in: supplierReturnIds } },
  });
  await prisma.purchasePayment.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.receivingLine.deleteMany({
    where: {
      OR: [
        { purchase: { businessId: { in: businessIds } } },
        { purchaseOrder: { businessId: { in: businessIds } } },
      ],
    },
  });
  await prisma.purchaseLine.deleteMany({
    where: { purchase: { businessId: { in: businessIds } } },
  });
  await prisma.purchaseOrderLine.deleteMany({
    where: { purchaseOrder: { businessId: { in: businessIds } } },
  });
  await prisma.purchase.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.purchaseOrder.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.supplierReturn.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.attachment.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.stockMovement.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.stockSnapshot.deleteMany({
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
  await prisma.supplier.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.approval.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.approvalPolicy.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.businessSettings.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.subscription.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.businessUser.deleteMany({
    where: { businessId: { in: businessIds } },
  });
  await prisma.idempotencyKey.deleteMany({
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
    'Phase D test data removed (audit logs retained; businesses marked DELETED).',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
