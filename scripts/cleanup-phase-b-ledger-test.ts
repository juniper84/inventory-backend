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
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set.');
  }
  if (process.env.CONFIRM !== 'YES') {
    throw new Error('Set CONFIRM=YES to run cleanup.');
  }

  const prefix = process.env.BUSINESS_NAME_PREFIX || 'Phase B Ledger Test';
  const prisma = new PrismaService();
  await prisma.$connect();

  const businesses = await prisma.business.findMany({
    where: { name: { startsWith: prefix } },
  });

  if (businesses.length === 0) {
    console.log('No Phase B test businesses found.');
    await prisma.$disconnect();
    return;
  }

  for (const business of businesses) {
    console.log(`Cleaning business ${business.id} (${business.name})`);

    await prisma.stockMovement.deleteMany({
      where: { businessId: business.id },
    });
    await prisma.stockSnapshot.deleteMany({
      where: { businessId: business.id },
    });

    await prisma.transferItem.deleteMany({
      where: { transfer: { businessId: business.id } },
    });
    await prisma.transfer.deleteMany({
      where: { businessId: business.id },
    });

    await prisma.branchVariantAvailability.deleteMany({
      where: { businessId: business.id },
    });
    await prisma.batch.deleteMany({
      where: { businessId: business.id },
    });
    await prisma.barcode.deleteMany({
      where: { businessId: business.id },
    });
    await prisma.productImage.deleteMany({
      where: { businessId: business.id },
    });
    await prisma.variant.deleteMany({
      where: { businessId: business.id },
    });
    await prisma.product.deleteMany({
      where: { businessId: business.id },
    });
    await prisma.category.deleteMany({
      where: { businessId: business.id },
    });

    await prisma.notification.deleteMany({
      where: { businessId: business.id },
    });
    await prisma.auditLog.deleteMany({
      where: { businessId: business.id },
    });

    await prisma.branch.deleteMany({
      where: { businessId: business.id },
    });
    await prisma.businessSettings.deleteMany({
      where: { businessId: business.id },
    });

    const memberships = await prisma.businessUser.findMany({
      where: { businessId: business.id },
    });
    await prisma.businessUser.deleteMany({
      where: { businessId: business.id },
    });

    await prisma.business.delete({
      where: { id: business.id },
    });

    for (const membership of memberships) {
      const otherMemberships = await prisma.businessUser.count({
        where: { userId: membership.userId },
      });
      if (otherMemberships === 0) {
        const user = await prisma.user.findUnique({
          where: { id: membership.userId },
        });
        if (user?.email?.includes('phaseb+') && user.email.endsWith('@local.test')) {
          await prisma.user.delete({ where: { id: membership.userId } });
          console.log(`Deleted test user ${membership.userId}`);
        }
      }
    }
  }

  await prisma.$disconnect();
  console.log('Phase B test data cleanup complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
