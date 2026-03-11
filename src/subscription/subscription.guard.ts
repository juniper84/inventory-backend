import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SubscriptionService } from './subscription.service';
import { SetMetadata } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { AuditService } from '../audit/audit.service';
import { buildRequestMetadata } from '../audit/audit.utils';
import { SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

export const SUBSCRIPTION_BYPASS_KEY = 'subscriptionBypass';
export const SubscriptionBypass = () =>
  SetMetadata(SUBSCRIPTION_BYPASS_KEY, true);

// NOTE: TECH DEBT — This guard implements a complex lazy state machine that handles
// TRIAL → GRACE → EXPIRED transitions inline on every request. This works but is
// fragile: multiple concurrent requests can each trigger the same transition.
// The updateMany+count pattern prevents duplicate writes but the logic is hard to follow.
// Future: Extract to a dedicated background scheduler that drives subscription state
// transitions on a cron basis, and simplify this guard to a pure status check.
@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly subscriptionService: SubscriptionService,
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }
    const bypass = this.reflector.getAllAndOverride<boolean>(
      SUBSCRIPTION_BYPASS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (bypass) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (user?.scope === 'platform' || user?.scope === 'support') {
      return true;
    }

    if (!user?.businessId) {
      return false;
    }

    const subscription = await this.subscriptionService.getSubscription(
      user.businessId,
    );

    request.subscription = subscription;

    if (!subscription) {
      await this.auditService.logEvent({
        businessId: user.businessId,
        userId: user.sub,
        action: 'SUBSCRIPTION_BLOCK',
        resourceType: 'Subscription',
        outcome: 'FAILURE',
        reason: 'Subscription not found',
        metadata: buildRequestMetadata(request),
      });
      return false;
    }

    const now = new Date();
    const graceDays = parseInt(
      this.configService.get<string>('subscription.expiredGraceDays') ??
        this.configService.get<string>('subscription.graceDays') ??
        '3',
      10,
    );
    const graceDurationMs = Math.max(graceDays, 0) * 24 * 60 * 60 * 1000;

    const trialEnded =
      subscription.status === SubscriptionStatus.TRIAL &&
      subscription.trialEndsAt &&
      subscription.trialEndsAt.getTime() <= now.getTime();
    const expiredAtPassed =
      subscription.status === SubscriptionStatus.ACTIVE &&
      subscription.expiresAt &&
      subscription.expiresAt.getTime() <= now.getTime();
    const graceActive =
      (subscription.status === SubscriptionStatus.GRACE ||
        (trialEnded && subscription.graceEndsAt)) &&
      subscription.graceEndsAt &&
      subscription.graceEndsAt.getTime() > now.getTime();
    const graceEnded =
      (subscription.status === SubscriptionStatus.GRACE ||
        (trialEnded && subscription.graceEndsAt)) &&
      subscription.graceEndsAt &&
      subscription.graceEndsAt.getTime() <= now.getTime();
    const expiredByDate =
      (subscription.expiresAt &&
        subscription.expiresAt.getTime() <= now.getTime()) ||
      (trialEnded && !subscription.graceEndsAt) ||
      graceEnded;

    let effectiveStatus = subscription.status;
    if (trialEnded && subscription.graceEndsAt) {
      effectiveStatus = graceActive
        ? SubscriptionStatus.GRACE
        : SubscriptionStatus.EXPIRED;
    } else if (trialEnded) {
      effectiveStatus = SubscriptionStatus.EXPIRED;
    } else if (expiredAtPassed && !subscription.graceEndsAt && graceDays > 0) {
      effectiveStatus = SubscriptionStatus.GRACE;
    } else if (expiredByDate) {
      effectiveStatus = SubscriptionStatus.EXPIRED;
    } else if (subscription.status === SubscriptionStatus.GRACE && graceEnded) {
      effectiveStatus = SubscriptionStatus.EXPIRED;
    }

    if (effectiveStatus !== subscription.status || expiredAtPassed) {
      const record = await this.prisma.subscription.findUnique({
        where: { businessId: user.businessId },
      });
      if (record) {
        if (
          effectiveStatus === SubscriptionStatus.GRACE &&
          (record.status !== SubscriptionStatus.GRACE || !record.graceEndsAt)
        ) {
          const graceEndsAt = record.graceEndsAt
            ? record.graceEndsAt
            : new Date(now.getTime() + graceDurationMs);
          const graceResult = await this.prisma.subscription.updateMany({
            where: {
              id: record.id,
              status: { not: SubscriptionStatus.GRACE },
            },
            data: { status: SubscriptionStatus.GRACE, graceEndsAt },
          });
          if (graceResult.count > 0) {
            await this.prisma.subscriptionHistory.create({
              data: {
                businessId: record.businessId,
                previousStatus: record.status,
                newStatus: SubscriptionStatus.GRACE,
                previousTier: record.tier,
                newTier: record.tier,
                changedByPlatformAdminId: null,
                reason: 'Auto-grace',
                metadata: {
                  graceEndsAt: graceEndsAt.toISOString(),
                },
              },
            });
            await this.auditService.logEvent({
              businessId: record.businessId,
              action: 'SUBSCRIPTION_STATUS_SYNC',
              resourceType: 'Subscription',
              resourceId: record.id,
              outcome: 'SUCCESS',
              metadata: {
                status: SubscriptionStatus.GRACE,
                graceEndsAt: graceEndsAt.toISOString(),
              },
            });
            await this.prisma.business.updateMany({
              where: {
                id: record.businessId,
                status: { not: 'GRACE' },
              },
              data: { status: 'GRACE' },
            });
          }
        }

        if (effectiveStatus === SubscriptionStatus.EXPIRED) {
          const expiresAt = record.expiresAt ?? now;
          const expiredResult = await this.prisma.subscription.updateMany({
            where: {
              id: record.id,
              status: { not: SubscriptionStatus.EXPIRED },
            },
            data: { status: SubscriptionStatus.EXPIRED, expiresAt },
          });
          const updated = expiredResult.count > 0
            ? await this.prisma.subscription.findUnique({
                where: { id: record.id },
                select: { id: true, status: true, expiresAt: true, tier: true },
              })
            : null;
          if (updated) {
            await this.prisma.businessSettings.updateMany({
              where: { businessId: record.businessId, readOnlyEnabled: false },
              data: {
                readOnlyEnabled: true,
                readOnlyReason:
                  record.status === SubscriptionStatus.TRIAL
                    ? 'Trial expired. Please subscribe to continue.'
                    : 'Subscription expired. Please pay to continue.',
                readOnlyEnabledAt: now,
              },
            });
            await this.prisma.offlineDevice.updateMany({
              where: { businessId: record.businessId, status: 'ACTIVE' },
              data: { status: 'REVOKED', revokedAt: now },
            });
            await this.prisma.subscriptionHistory.create({
              data: {
                businessId: record.businessId,
                previousStatus: record.status,
                newStatus: SubscriptionStatus.EXPIRED,
                previousTier: record.tier,
                newTier: record.tier,
                changedByPlatformAdminId: null,
                reason: 'Auto-expired',
                metadata: { expiresAt: expiresAt.toISOString() },
              },
            });
            await this.auditService.logEvent({
              businessId: record.businessId,
              action: 'SUBSCRIPTION_STATUS_SYNC',
              resourceType: 'Subscription',
              resourceId: record.id,
              outcome: 'SUCCESS',
              metadata: {
                status: updated.status,
                expiresAt: expiresAt.toISOString(),
              },
            });
            await this.prisma.business.updateMany({
              where: {
                id: record.businessId,
                status: { not: 'EXPIRED' },
              },
              data: { status: 'EXPIRED' },
            });
          }
        }
      }
    }

    request.subscription = { ...subscription, status: effectiveStatus };

    const isExpiredOrSuspended =
      effectiveStatus === SubscriptionStatus.SUSPENDED ||
      effectiveStatus === SubscriptionStatus.EXPIRED;

    if (isExpiredOrSuspended || effectiveStatus === SubscriptionStatus.GRACE) {
      const methodAllowed = ['GET', 'HEAD', 'OPTIONS'].includes(request.method);
      if (!methodAllowed) {
        await this.auditService.logEvent({
          businessId: user.businessId,
          userId: user.sub,
          action: 'SUBSCRIPTION_BLOCK',
          resourceType: 'Subscription',
          outcome: 'FAILURE',
          reason: isExpiredOrSuspended ? 'EXPIRED' : 'GRACE',
          metadata: buildRequestMetadata(request),
        });
      }
      return methodAllowed;
    }

    await this.auditService.logEvent({
      businessId: user.businessId,
      userId: user.sub,
      action: 'SUBSCRIPTION_CHECK',
      resourceType: 'Subscription',
      outcome: 'SUCCESS',
      metadata: {
        status: subscription.status,
        ...buildRequestMetadata(request),
      },
    });

    return true;
  }
}
