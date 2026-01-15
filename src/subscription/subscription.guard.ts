import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SubscriptionService } from './subscription.service';
import { SetMetadata } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { AuditService } from '../audit/audit.service';
import { buildRequestMetadata } from '../audit/audit.utils';

export const SUBSCRIPTION_BYPASS_KEY = 'subscriptionBypass';
export const SubscriptionBypass = () =>
  SetMetadata(SUBSCRIPTION_BYPASS_KEY, true);

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly subscriptionService: SubscriptionService,
    private readonly auditService: AuditService,
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

    if (['EXPIRED', 'SUSPENDED'].includes(subscription.status)) {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        await this.auditService.logEvent({
          businessId: user.businessId,
          userId: user.sub,
          action: 'SUBSCRIPTION_BLOCK',
          resourceType: 'Subscription',
          outcome: 'FAILURE',
          reason: subscription.status,
          metadata: buildRequestMetadata(request),
        });
      }
      return ['GET', 'HEAD', 'OPTIONS'].includes(request.method);
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
