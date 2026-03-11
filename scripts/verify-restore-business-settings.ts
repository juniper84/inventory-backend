import { PrismaClient, Prisma } from '@prisma/client';
import {
  DEFAULT_APPROVAL_DEFAULTS,
  DEFAULT_LOCALE_SETTINGS,
  DEFAULT_POS_POLICIES,
  DEFAULT_STOCK_POLICIES,
} from '../src/settings/defaults';
import { normalizeNotificationSettings } from '../src/notifications/notification-config';

const prisma = new PrismaClient();

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const stable = (value: unknown) => JSON.stringify(value ?? null);

const mergePosPolicies = (current: unknown) => {
  const obj = asObject(current);
  const offline = asObject(obj.offlineLimits);
  return {
    ...DEFAULT_POS_POLICIES,
    ...obj,
    offlineLimits: {
      ...DEFAULT_POS_POLICIES.offlineLimits,
      ...offline,
    },
  };
};

const run = async () => {
  const email = process.env.NVI_TEST_EMAIL?.trim();
  const apply = process.env.NVI_FIX === 'true';
  if (!email) {
    throw new Error('Set NVI_TEST_EMAIL to target the test user.');
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      memberships: {
        where: { status: 'ACTIVE' },
        select: {
          businessId: true,
          business: { select: { name: true } },
        },
      },
    },
  });
  if (!user) {
    throw new Error(`User not found: ${email}`);
  }
  if (!user.memberships.length) {
    throw new Error(`No active businesses found for ${email}`);
  }

  console.log(
    `Checking ${user.memberships.length} active business(es) for ${user.email}...`,
  );

  for (const membership of user.memberships) {
    const businessId = membership.businessId;
    const settings = await prisma.businessSettings.findUnique({
      where: { businessId },
    });

    const currentApproval = asObject(settings?.approvalDefaults);
    const currentPos = asObject(settings?.posPolicies);
    const currentStock = asObject(settings?.stockPolicies);
    const currentLocale = asObject(settings?.localeSettings);
    const currentNotif = asObject(settings?.notificationDefaults);

    const nextApproval = {
      ...DEFAULT_APPROVAL_DEFAULTS,
      ...currentApproval,
    };
    const nextPos = mergePosPolicies(currentPos);
    const nextStock = {
      ...DEFAULT_STOCK_POLICIES,
      ...currentStock,
    };
    const nextLocale = {
      ...DEFAULT_LOCALE_SETTINGS,
      ...currentLocale,
    };
    const nextNotif = normalizeNotificationSettings(currentNotif);

    const needsUpdate =
      !settings ||
      stable(currentApproval) !== stable(nextApproval) ||
      stable(currentPos) !== stable(nextPos) ||
      stable(currentStock) !== stable(nextStock) ||
      stable(currentLocale) !== stable(nextLocale) ||
      stable(currentNotif) !== stable(nextNotif);

    console.log(
      `- ${membership.business.name} (${businessId}): ${
        needsUpdate ? 'needs restore' : 'ok'
      }`,
    );

    if (!apply || !needsUpdate) {
      continue;
    }

    await prisma.businessSettings.upsert({
      where: { businessId },
      create: {
        businessId,
        approvalDefaults: nextApproval as Prisma.InputJsonValue,
        posPolicies: nextPos as Prisma.InputJsonValue,
        stockPolicies: nextStock as Prisma.InputJsonValue,
        localeSettings: nextLocale as Prisma.InputJsonValue,
        notificationDefaults: nextNotif as Prisma.InputJsonValue,
      },
      update: {
        approvalDefaults: nextApproval as Prisma.InputJsonValue,
        posPolicies: nextPos as Prisma.InputJsonValue,
        stockPolicies: nextStock as Prisma.InputJsonValue,
        localeSettings: nextLocale as Prisma.InputJsonValue,
        notificationDefaults: nextNotif as Prisma.InputJsonValue,
      },
    });
  }

  console.log(apply ? 'Restore completed.' : 'Dry-run completed.');
};

run()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

