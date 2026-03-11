import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SubscriptionStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SubscriptionReminderService
  implements OnModuleInit, OnModuleDestroy
{
  private intervalId: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly notificationsService: NotificationsService,
    private readonly auditService: AuditService,
  ) {}

  onModuleInit() {
    const hours = parseInt(
      this.configService.get<string>(
        'subscription.graceReminderIntervalHours',
      ) ?? '24',
      10,
    );
    const intervalMs = Math.max(hours, 1) * 60 * 60 * 1000;
    this.runGraceReminderSweep();
    this.runExpirySweep();
    this.intervalId = setInterval(() => {
      this.runGraceReminderSweep();
      this.runExpirySweep();
    }, intervalMs);
  }

  onModuleDestroy() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async runGraceReminderSweep() {
    const windowDays = parseInt(
      this.configService.get<string>('subscription.graceReminderWindowDays') ??
        '7',
      10,
    );
    const now = new Date();
    const windowEnd = new Date(now);
    windowEnd.setDate(windowEnd.getDate() + Math.max(windowDays, 0));

    const candidates = await this.prisma.subscription.findMany({
      where: {
        status: SubscriptionStatus.GRACE,
        graceEndsAt: { not: null, lte: windowEnd },
        graceReminderSentAt: null,
      },
      include: { business: { select: { name: true } } },
    });

    await Promise.allSettled(
      candidates.map(async (subscription) => {
        const notify = await this.notificationsService.isEventEnabled(
          subscription.businessId,
          'graceWarnings',
        );
        if (!notify) {
          return;
        }
        const graceEndsAt = subscription.graceEndsAt;
        const daysRemaining = graceEndsAt
          ? Math.max(
              0,
              Math.ceil(
                (graceEndsAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
              ),
            )
          : null;

        const reminderSentAt = new Date();
        const updated = await this.prisma.subscription.update({
          where: { id: subscription.id },
          data: { graceReminderSentAt: reminderSentAt },
          select: {
            id: true,
            status: true,
            graceEndsAt: true,
            graceReminderSentAt: true,
            businessId: true,
          },
        });

        await this.notificationsService.notifyEvent({
          businessId: subscription.businessId,
          eventKey: 'graceWarnings',
          title: 'Grace period reminder',
          message:
            daysRemaining !== null
              ? `Your subscription grace period ends in ${daysRemaining} day(s).`
              : 'Your subscription is in grace period. Please update billing.',
          priority: 'WARNING',
          metadata: {
            graceEndsAt: graceEndsAt?.toISOString() ?? null,
            businessName: subscription.business?.name ?? null,
          },
        });

        await this.auditService.logEvent({
          businessId: subscription.businessId,
          action: 'SUBSCRIPTION_GRACE_REMINDER',
          resourceType: 'Subscription',
          resourceId: subscription.id,
          outcome: 'SUCCESS',
          metadata: { graceEndsAt: graceEndsAt?.toISOString() ?? null },
          before: {
            id: subscription.id,
            status: subscription.status,
            graceEndsAt: subscription.graceEndsAt,
            graceReminderSentAt: subscription.graceReminderSentAt,
            businessId: subscription.businessId,
          },
          after: updated as unknown as Record<string, unknown>,
        });
      }),
    );
  }

  private async runExpirySweep() {
    const now = new Date();
    const candidates = await this.prisma.subscription.findMany({
      where: {
        status: {
          in: [
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.GRACE,
            SubscriptionStatus.TRIAL,
          ],
        },
        expiresAt: { not: null, lte: now },
      },
      include: { business: { select: { name: true } } },
    });

    await Promise.allSettled(
      candidates.map(async (subscription) => {
        const updated = await this.prisma.$transaction(async (tx) => {
          const expireResult = await tx.subscription.updateMany({
            where: { id: subscription.id, status: { not: SubscriptionStatus.EXPIRED } },
            data: { status: SubscriptionStatus.EXPIRED },
          });

          // Another instance or guard already expired this subscription — skip follow-on effects
          if (expireResult.count === 0) {
            return null;
          }

          const refreshed = await tx.subscription.findUnique({
            where: { id: subscription.id },
            select: { id: true, status: true, expiresAt: true, businessId: true, tier: true },
          });

          await tx.businessSettings.updateMany({
            where: { businessId: subscription.businessId, readOnlyEnabled: false },
            data: {
              readOnlyEnabled: true,
              readOnlyReason: 'Subscription expired.',
              readOnlyEnabledAt: now,
            },
          });

          await tx.business.updateMany({
            where: { id: subscription.businessId, status: { not: 'EXPIRED' } },
            data: { status: 'EXPIRED' },
          });

          await tx.offlineDevice.updateMany({
            where: { businessId: subscription.businessId, status: 'ACTIVE' },
            data: { status: 'REVOKED', revokedAt: now },
          });

          await tx.subscriptionHistory.create({
            data: {
              businessId: subscription.businessId,
              previousStatus: subscription.status,
              newStatus: SubscriptionStatus.EXPIRED,
              previousTier: subscription.tier,
              newTier: subscription.tier,
              changedByPlatformAdminId: null,
              reason: 'Auto-expired',
              metadata: { expiresAt: subscription.expiresAt?.toISOString() ?? null },
            },
          });

          return refreshed;
        });

        if (updated === null) {
          return;
        }

        await this.auditService.logEvent({
          businessId: subscription.businessId,
          action: 'SUBSCRIPTION_EXPIRED',
          resourceType: 'Subscription',
          resourceId: subscription.id,
          outcome: 'SUCCESS',
          metadata: {
            businessName: subscription.business?.name ?? null,
            expiresAt: subscription.expiresAt?.toISOString() ?? null,
          },
          before: {
            id: subscription.id,
            status: subscription.status,
            expiresAt: subscription.expiresAt,
            businessId: subscription.businessId,
          },
          after: (updated ?? {}) as unknown as Record<string, unknown>,
        });
      }),
    );
  }
}
