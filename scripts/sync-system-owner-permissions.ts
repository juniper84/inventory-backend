import fs from 'fs';
import path from 'path';
import { PrismaService } from '../src/prisma/prisma.service';
import { PermissionsList } from '../src/rbac/permissions';

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

  const codes = Object.values(PermissionsList);
  await prisma.permission.createMany({
    data: codes.map((code) => ({ code })),
    skipDuplicates: true,
  });

  const permissions = await prisma.permission.findMany({
    where: { code: { in: codes } },
    select: { id: true },
  });

  const roles = await prisma.role.findMany({
    where: { name: 'System Owner' },
    select: { id: true, businessId: true, name: true },
  });

  if (roles.length === 0) {
    console.log('No System Owner roles found.');
    return;
  }

  for (const role of roles) {
    await prisma.rolePermission.createMany({
      data: permissions.map((permission) => ({
        roleId: role.id,
        permissionId: permission.id,
      })),
      skipDuplicates: true,
    });
  }

  console.log(
    `Synced ${permissions.length} permissions to ${roles.length} System Owner roles.`,
  );
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
