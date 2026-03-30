import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformEventService } from '../platform/platform-event.service';
import {
  Prisma,
  SubscriptionRequestStatus,
  SubscriptionRequestType,
  SubscriptionStatus,
  SubscriptionTier,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';

// FNV-1a 32-bit hash for generating pg_advisory_xact_lock keys.
// Returns a signed int32 safe to pass as a PostgreSQL int4 parameter.
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

export type SubscriptionSnapshot = {
  status: SubscriptionStatus;
  tier: SubscriptionTier;
  limits: Record<string, number | string | boolean | null>;
  trialEndsAt: Date | null;
  graceEndsAt: Date | null;
  expiresAt: Date | null;
};

const DEFAULT_LIMITS: Record<SubscriptionTier, SubscriptionSnapshot['limits']> =
  {
    STARTER: {
      users: 5,
      branches: 1,
      products: 5000,
      monthlyTransactions: 15000,
      offline: false,
      offlineDevices: 0,
      storageGb: 10,
      reminders: false,
      reminderEmail: false,
      reminderWhatsApp: false,
    },
    BUSINESS: {
      users: 15,
      branches: 5,
      products: 30000,
      monthlyTransactions: 40000,
      offline: true,
      offlineDevices: 5,
      storageGb: 35,
      reminders: true,
      reminderEmail: true,
      reminderWhatsApp: false,
    },
    ENTERPRISE: {
      users: -1,
      branches: -1,
      products: -1,
      monthlyTransactions: -1,
      offline: true,
      offlineDevices: -1,
      storageGb: -1,
      reminders: true,
      reminderEmail: true,
      reminderWhatsApp: true,
    },
  };

@Injectable()
export class SubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly platformEvents: PlatformEventService,
  ) {}

  async getSubscription(
    businessId: string,
  ): Promise<SubscriptionSnapshot | null> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { businessId },
    });

    if (!subscription) {
      return null;
    }

    const defaultLimits = DEFAULT_LIMITS[subscription.tier];
    const storedLimits =
      (subscription.limits as SubscriptionSnapshot['limits']) || {};

    return {
      status: subscription.status,
      tier: subscription.tier,
      limits: { ...defaultLimits, ...storedLimits },
      trialEndsAt: subscription.trialEndsAt,
      graceEndsAt: subscription.graceEndsAt,
      expiresAt: subscription.expiresAt,
    };
  }

  async createTrialSubscription(businessId: string, tier: SubscriptionTier, actorId?: string) {
    const existing = await this.prisma.subscription.findUnique({
      where: { businessId },
    });
    if (existing) {
      throw new BadRequestException('Subscription already exists.');
    }

    const now = new Date();
    const defaultTrialDays = parseInt(
      this.configService.get<string>('subscription.trialDays') ?? '14',
      10,
    );
    const enterpriseTrialDays = parseInt(
      this.configService.get<string>('subscription.enterpriseTrialDays') ?? '7',
      10,
    );
    const trialDays =
      tier === SubscriptionTier.ENTERPRISE
        ? enterpriseTrialDays
        : defaultTrialDays;
    const trialEndsAt = new Date(now);
    trialEndsAt.setDate(trialEndsAt.getDate() + trialDays);

    const created = await this.prisma.subscription.create({
      data: {
        businessId,
        tier,
        status: SubscriptionStatus.TRIAL,
        trialEndsAt,
        limits: DEFAULT_LIMITS[tier],
      },
    });
    await this.auditService.logEvent({
      businessId,
      userId: actorId ?? 'background',
      action: 'SUBSCRIPTION_CREATE',
      resourceType: 'Subscription',
      resourceId: created.id,
      outcome: 'SUCCESS',
      metadata: {
        resourceName: `${tier} (${SubscriptionStatus.TRIAL})`,
        tier,
        status: SubscriptionStatus.TRIAL,
      },
      after: created as unknown as Record<string, unknown>,
    });
    return created;
  }

  async getSubscriptionSummary(businessId: string) {
    const subscription = await this.getSubscription(businessId);
    if (!subscription) {
      return null;
    }

    const [users, branches, products, devices] = await Promise.all([
      this.prisma.businessUser.count({ where: { businessId } }),
      this.prisma.branch.count({ where: { businessId } }),
      this.prisma.product.count({ where: { businessId } }),
      this.prisma.offlineDevice.count({ where: { businessId } }),
    ]);

    const warnings: { type: string; message: string }[] = [];
    if (subscription.status === SubscriptionStatus.GRACE) {
      const daysRemaining = subscription.graceEndsAt
        ? Math.max(
            0,
            Math.ceil(
              (subscription.graceEndsAt.getTime() - Date.now()) /
                (1000 * 60 * 60 * 24),
            ),
          )
        : null;
      warnings.push({
        type: 'GRACE_PERIOD',
        message:
          daysRemaining !== null
            ? `Grace period ends in ${daysRemaining} day(s).`
            : 'Your subscription is in grace period.',
      });
    }

    return {
      ...subscription,
      usage: {
        users,
        branches,
        products,
        devices,
      },
      warnings,
    };
  }

  async assertLimit(
    businessId: string,
    key: keyof SubscriptionSnapshot['limits'],
    amount: number = 1,
    tx?: Prisma.TransactionClient,
  ) {
    const subscription = await this.getSubscription(businessId);
    if (!subscription) {
      throw new BadRequestException('Subscription not found.');
    }

    const limit = subscription.limits[key];
    if (typeof limit !== 'number' || limit < 0) {
      return;
    }

    // When running inside a transaction, acquire a per-(businessId, key)
    // advisory lock so that concurrent requests cannot both pass the count
    // check and then both write beyond the limit (TOCTOU prevention).
    if (tx) {
      await tx.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock($1::int4, $2::int4)',
        fnv1a32(businessId),
        fnv1a32(String(key)),
      );
    }

    const client = tx ?? this.prisma;

    let count = 0;
    switch (key) {
      case 'users':
        count = await client.businessUser.count({ where: { businessId } });
        break;
      case 'branches':
        count = await client.branch.count({ where: { businessId } });
        break;
      case 'products':
        count = await client.product.count({ where: { businessId } });
        break;
      case 'offlineDevices':
        count = await client.offlineDevice.count({
          where: { businessId },
        });
        break;
      case 'monthlyTransactions': {
        // FIXME: This counts PurchaseOrder creation AND the resulting Purchase receipt
        // as separate transactions, effectively double-counting a single purchasing workflow.
        // A PurchaseOrder that gets received generates a Purchase, so one business action
        // consumes two transaction slots. This should be reviewed and a consistent
        // definition of "transaction" established (e.g. only count Sales + Purchases).
        const start = new Date();
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
        const [sales, purchases, orders] = await Promise.all([
          client.sale.count({
            where: { businessId, createdAt: { gte: start } },
          }),
          client.purchase.count({
            where: { businessId, createdAt: { gte: start } },
          }),
          client.purchaseOrder.count({
            where: { businessId, createdAt: { gte: start } },
          }),
        ]);
        count = sales + purchases + orders;
        break;
      }
      case 'storageGb': {
        const aggregate = await client.attachment.aggregate({
          where: { businessId, status: 'ACTIVE' },
          _sum: { sizeMb: true },
        });
        const usedMb = aggregate._sum.sizeMb
          ? Number(aggregate._sum.sizeMb)
          : 0;
        const limitMb = limit * 1024;
        if (usedMb + amount > limitMb) {
          throw new BadRequestException('Storage limit exceeded.');
        }
        return;
      }
      default:
        break;
    }

    if (count + Math.max(amount, 0) > limit) {
      throw new BadRequestException('Subscription limit exceeded.');
    }
  }

  async listSubscriptionRequests(businessId: string) {
    return this.prisma.subscriptionRequest.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createSubscriptionRequest(
    businessId: string,
    userId: string,
    data: {
      type: SubscriptionRequestType | 'UPGRADE' | 'DOWNGRADE' | 'CANCEL';
      requestedTier?: SubscriptionTier | 'STARTER' | 'BUSINESS' | 'ENTERPRISE';
      reason?: string;
    },
  ) {
    if (!businessId) {
      throw new BadRequestException('Business context required.');
    }
    const type = data.type;
    if (
      (type === SubscriptionRequestType.UPGRADE ||
        type === SubscriptionRequestType.DOWNGRADE) &&
      !data.requestedTier
    ) {
      throw new BadRequestException('Requested tier is required.');
    }
    const existing = await this.prisma.subscriptionRequest.findFirst({
      where: { businessId, status: SubscriptionRequestStatus.PENDING },
    });
    if (existing) {
      throw new BadRequestException(
        'A pending subscription request already exists.',
      );
    }
    const request = await this.prisma.subscriptionRequest.create({
      data: {
        businessId,
        requestedByUserId: userId,
        type,
        requestedTier: data.requestedTier ? data.requestedTier : null,
        reason: data.reason ?? null,
      },
    });
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'SUBSCRIPTION_REQUEST',
      resourceType: 'SubscriptionRequest',
      resourceId: request.id,
      outcome: 'SUCCESS',
      reason: data.reason ?? undefined,
      metadata: {
        type,
        requestedTier: data.requestedTier ?? null,
      },
    });
    this.platformEvents.emit('subscription_request.created', {
      requestId: request.id,
      businessId,
      type,
      requestedTier: data.requestedTier ?? null,
    });
    return request;
  }
}
