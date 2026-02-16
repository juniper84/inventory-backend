import { SubscriptionGuard } from './subscription.guard';
import { SubscriptionStatus } from '@prisma/client';

describe('SubscriptionGuard automation', () => {
  const buildContext = (request: Record<string, unknown>) =>
    ({
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as any;

  const buildGuard = () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as any;
    const subscriptionService = {
      getSubscription: jest.fn(),
    } as any;
    const auditService = {
      logEvent: jest.fn().mockResolvedValue(undefined),
    } as any;
    const prisma = {
      subscription: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      subscriptionHistory: {
        create: jest.fn().mockResolvedValue(undefined),
      },
      businessSettings: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      business: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      offlineDevice: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as any;
    const configService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'subscription.expiredGraceDays') return '7';
        if (key === 'subscription.graceDays') return '7';
        return null;
      }),
    } as any;

    const guard = new SubscriptionGuard(
      reflector,
      subscriptionService,
      auditService,
      prisma,
      configService,
    );

    return { guard, subscriptionService, prisma };
  };

  it('auto-transitions active subscriptions to grace when expiry passes', async () => {
    const { guard, subscriptionService, prisma } = buildGuard();
    const now = Date.now();
    const request = {
      method: 'POST',
      user: { sub: 'user-1', businessId: 'biz-1' },
    } as any;
    const subscription = {
      id: 'sub-1',
      businessId: 'biz-1',
      tier: 'BUSINESS',
      status: SubscriptionStatus.ACTIVE,
      trialEndsAt: null,
      graceEndsAt: null,
      expiresAt: new Date(now - 60_000),
    };
    subscriptionService.getSubscription.mockResolvedValue(subscription);
    prisma.subscription.findUnique.mockResolvedValue(subscription);
    prisma.subscription.update.mockResolvedValue({
      id: 'sub-1',
      status: SubscriptionStatus.GRACE,
      tier: 'BUSINESS',
      graceEndsAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
    });

    const allowed = await guard.canActivate(buildContext(request));

    expect(allowed).toBe(false);
    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: SubscriptionStatus.GRACE,
        }),
      }),
    );
    expect(prisma.subscriptionHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          newStatus: SubscriptionStatus.GRACE,
          reason: 'Auto-grace',
        }),
      }),
    );
    expect(prisma.business.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'GRACE' },
      }),
    );
  });

  it('auto-transitions grace subscriptions to expired and enforces read-only', async () => {
    const { guard, subscriptionService, prisma } = buildGuard();
    const now = Date.now();
    const request = {
      method: 'POST',
      user: { sub: 'user-2', businessId: 'biz-2' },
    } as any;
    const subscription = {
      id: 'sub-2',
      businessId: 'biz-2',
      tier: 'BUSINESS',
      status: SubscriptionStatus.GRACE,
      trialEndsAt: null,
      graceEndsAt: new Date(now - 60_000),
      expiresAt: new Date(now - 2 * 60_000),
    };
    subscriptionService.getSubscription.mockResolvedValue(subscription);
    prisma.subscription.findUnique.mockResolvedValue(subscription);
    prisma.subscription.update.mockResolvedValue({
      id: 'sub-2',
      status: SubscriptionStatus.EXPIRED,
      tier: 'BUSINESS',
      expiresAt: new Date(now),
    });

    const allowed = await guard.canActivate(buildContext(request));

    expect(allowed).toBe(false);
    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: SubscriptionStatus.EXPIRED,
        }),
      }),
    );
    expect(prisma.businessSettings.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ businessId: 'biz-2' }),
        data: expect.objectContaining({ readOnlyEnabled: true }),
      }),
    );
    expect(prisma.offlineDevice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ businessId: 'biz-2' }),
      }),
    );
    expect(prisma.business.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'EXPIRED' },
      }),
    );
  });
});
