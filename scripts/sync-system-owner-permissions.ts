/**
 * Syncs the Permission table with the current PermissionsList catalog,
 * then ensures all System Owner roles hold every permission.
 *
 * Run from the backend directory:
 *   npx ts-node scripts/sync-system-owner-permissions.ts
 */

import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const ALL_PERMISSION_CODES: string[] = [
  'business.read', 'business.update', 'business.delete',
  'users.read', 'users.create', 'users.update', 'users.deactivate',
  'roles.read', 'roles.create', 'roles.update',
  'catalog.read', 'catalog.write',
  'stock.read', 'stock.write',
  'transfers.read', 'transfers.write',
  'sales.read', 'sales.write',
  'purchases.read', 'purchases.write',
  'suppliers.read', 'suppliers.write',
  'expenses.read', 'expenses.write',
  'reports.read', 'exports.write', 'imports.write', 'audit.read',
  'offline.read', 'offline.write',
  'attachments.read', 'attachments.write',
  'customers.read', 'customers.create', 'customers.update',
  'customers.export', 'customers.sensitive.read', 'customers.anonymize',
  'price-lists.manage',
  'shifts.open', 'shifts.close',
  'sales.credit.create', 'sales.credit.settle', 'sales.return.without-receipt',
  'search.read',
  'settings.read', 'settings.write',
  'notifications.read',
  'notes.read', 'notes.write', 'notes.manage',
  'approvals.read', 'approvals.write',
  'subscription.read', 'subscription.request',
  'support-chat.use',
];

async function main() {
  const prisma = new PrismaClient();
  try {
    await prisma.permission.createMany({
      data: ALL_PERMISSION_CODES.map((code) => ({ code })),
      skipDuplicates: true,
    });
    console.log(`✓ Permission catalog synced (${ALL_PERMISSION_CODES.length} codes)`);

    const allPermissions = await prisma.permission.findMany({ select: { id: true } });
    console.log(`  ${allPermissions.length} permissions now in DB`);

    const ownerRoles = await prisma.role.findMany({
      where: { name: 'System Owner', isSystem: true },
      select: { id: true },
    });

    if (ownerRoles.length === 0) {
      console.log('  No System Owner roles found — nothing to assign.');
      return;
    }

    await prisma.rolePermission.createMany({
      data: ownerRoles.flatMap((role: { id: string }) =>
        allPermissions.map((permission: { id: string }) => ({
          roleId: role.id,
          permissionId: permission.id,
        })),
      ),
      skipDuplicates: true,
    });

    console.log(`✓ System Owner permissions updated across ${ownerRoles.length} business(es)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
