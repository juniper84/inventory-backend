import { SubscriptionReminderService } from './subscription-reminder.service';
import { SubscriptionStatus } from '@prisma/client';

describe('SubscriptionReminderService automation', () => {
  const buildService = () => {
    const prisma = {
      subscription: {
        findMany: jest.fn(),
        update: jest.fn(),
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
      subscriptionHistory: {
        create: jest.fn().mockResolvedValue(undefined),
      },
    } as any;
    const configService = {
      get: jest.fn().mockReturnValue('7'),
    } as any;
    const notificationsService = {
      isEventEnabled: jest.fn().mockResolvedValue(true),
      notifyEvent: jest.fn().mockResolvedValue(undefined),
    } as any;
    const auditService = {
      logEvent: jest.fn().mockResolvedValue(undefined),
    } as any;
    const service = new SubscriptionReminderService(
      prisma,
      configService,
      notificationsService,
      auditService,
    );
    return { service, prisma, auditService };
  };

  it('marks expired subscriptions as expired and syncs read-only/business status', async () => {
    const { service, prisma, auditService } = buildService();
    prisma.subscription.findMany.mockResolvedValue([
      {
        id: 'sub-1',
        businessId: 'biz-1',
        tier: 'BUSINESS',
        status: SubscriptionStatus.ACTIVE,
        expiresAt: new Date('2026-02-09T00:00:00.000Z'),
        business: { name: 'Alpha' },
      },
    ]);
    prisma.subscription.update.mockResolvedValue({
      id: 'sub-1',
      status: SubscriptionStatus.EXPIRED,
      expiresAt: new Date('2026-02-09T00:00:00.000Z'),
      businessId: 'biz-1',
      tier: 'BUSINESS',
    });

    await (service as any).runExpirySweep();

    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: SubscriptionStatus.EXPIRED },
      }),
    );
    expect(prisma.businessSettings.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ businessId: 'biz-1' }),
        data: expect.objectContaining({ readOnlyEnabled: true }),
      }),
    );
    expect(prisma.business.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'biz-1' }),
        data: { status: 'EXPIRED' },
      }),
    );
    expect(prisma.offlineDevice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ businessId: 'biz-1' }),
      }),
    );
    expect(prisma.subscriptionHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          businessId: 'biz-1',
          newStatus: SubscriptionStatus.EXPIRED,
          reason: 'Auto-expired',
        }),
      }),
    );
    expect(auditService.logEvent).toHaveBeenCalled();
  });
});
