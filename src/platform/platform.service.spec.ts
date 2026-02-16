import { BadRequestException } from '@nestjs/common';
import { PlatformService } from './platform.service';

describe('PlatformService', () => {
  const buildService = (prismaOverrides: any = {}) => {
    const prisma = {
      platformAnnouncement: { count: jest.fn() },
      platformAuditLog: { findMany: jest.fn() },
      business: { findUnique: jest.fn() },
      subscription: { groupBy: jest.fn() },
      supportAccessRequest: { count: jest.fn() },
      exportJob: { count: jest.fn() },
      subscriptionRequest: { count: jest.fn() },
      offlineDevice: { findMany: jest.fn(), count: jest.fn() },
      offlineAction: { count: jest.fn() },
      businessUser: { count: jest.fn(), groupBy: jest.fn() },
      auditLog: { findMany: jest.fn() },
      ...prismaOverrides,
    } as any;

    const service = new PlatformService(
      {} as any,
      {} as any,
      {} as any,
      prisma,
      {} as any,
      {} as any,
      {} as any,
      { get: jest.fn().mockReturnValue('7') } as any,
    );

    return { service, prisma };
  };

  it('builds overview snapshot using aggregate sources', async () => {
    const { service, prisma } = buildService();
    jest.spyOn(service as any, 'getPlatformMetrics').mockResolvedValue({
      totals: {
        businesses: 12,
        active: 9,
        underReview: 2,
        offlineEnabled: 5,
      },
      storage: { totalMb: 123.4 },
      exports: { pending: 7 },
      offlineFailures: 3,
      api: { errorRate: 0.014, avgLatency: 182 },
      range: { start: '2026-02-09T00:00:00.000Z', end: '2026-02-09T23:59:59.000Z' },
      series: [],
    });
    jest.spyOn(service as any, 'buildQueuesSummary').mockResolvedValue({
      support: { total: 3, byStatus: { PENDING: 2, APPROVED: 1 } },
      exports: { total: 4, byStatus: { PENDING: 3, FAILED: 1 } },
      subscriptions: { total: 1, byStatus: { PENDING: 1 } },
    });

    prisma.platformAnnouncement.count.mockResolvedValue(2);
    prisma.platformAuditLog.findMany.mockResolvedValue([
      {
        id: 'log-1',
        action: 'BUSINESS_STATUS_UPDATE',
        resourceType: 'Business',
        resourceId: 'biz-1',
        reason: 'status transition',
        metadata: null,
        createdAt: new Date('2026-02-09T12:00:00.000Z'),
      },
    ]);
    prisma.subscription.groupBy.mockResolvedValue([
      { tier: 'BUSINESS', _count: { _all: 8 } },
      { tier: 'ENTERPRISE', _count: { _all: 2 } },
    ]);
    prisma.businessUser.groupBy.mockResolvedValue([
      { status: 'ACTIVE', _count: { _all: 21 } },
      { status: 'INACTIVE', _count: { _all: 4 } },
      { status: 'PENDING', _count: { _all: 3 } },
    ]);

    const snapshot = await service.getOverviewSnapshot({
      range: '24h',
      from: null,
      to: null,
    });

    expect(snapshot.kpis).toEqual({
      businesses: 12,
      activeBusinesses: 9,
      underReview: 2,
      offlineEnabled: 5,
      totalStorageMb: 123.4,
      totalUsers: 28,
      activeUsers: 21,
    });
    expect(snapshot.anomalies).toEqual({
      offlineFailures: 3,
      exportsPending: 7,
      apiErrorRate: 0.014,
      apiAvgLatencyMs: 182,
      activeAnnouncements: 2,
    });
    expect(snapshot.queues.support.total).toBe(3);
    expect(snapshot.distributions.tiers).toEqual([
      { tier: 'STARTER', count: 0 },
      { tier: 'BUSINESS', count: 8 },
      { tier: 'ENTERPRISE', count: 2 },
      { tier: 'UNKNOWN', count: 2 },
    ]);
    expect(snapshot.distributions.users).toEqual({
      active: 21,
      inactive: 4,
      pending: 3,
      total: 28,
    });
    expect(snapshot.signals).toEqual(
      expect.objectContaining({
        queuePressureTotal: 8,
        exportsFailed: 1,
      }),
    );
    expect(snapshot.activity).toHaveLength(1);
  });

  it('returns preflight not-ready for purge when business is not archived/deleted', async () => {
    const { service, prisma } = buildService();
    prisma.business.findUnique.mockResolvedValue({
      id: 'biz-1',
      name: 'Biz One',
      status: 'ACTIVE',
      updatedAt: new Date('2026-02-09T10:00:00.000Z'),
      subscription: { status: 'ACTIVE' },
      settings: { readOnlyEnabled: false, readOnlyReason: null },
    });
    prisma.exportJob.count.mockResolvedValue(2);
    prisma.offlineDevice.count.mockResolvedValue(4);
    prisma.offlineAction.count.mockResolvedValue(1);
    prisma.businessUser.count.mockResolvedValue(11);

    const preflight = await service.getBusinessActionPreflight('biz-1', 'PURGE');

    expect(preflight.ready).toBe(false);
    expect(preflight.preconditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'BUSINESS_ARCHIVED',
          ok: false,
        }),
      ]),
    );
    expect(preflight.impact.pendingExports).toBe(2);
    expect(preflight.impact.activeDevices).toBe(4);
  });

  it('loads business workspace aggregate payload', async () => {
    const { service, prisma } = buildService();
    prisma.business.findUnique.mockResolvedValue({
      id: 'biz-1',
      name: 'Biz One',
      status: 'ACTIVE',
      underReview: true,
      reviewReason: 'risk review',
      reviewSeverity: 'HIGH',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-02-09T12:00:00.000Z'),
      lastActivityAt: new Date('2026-02-09T10:00:00.000Z'),
      subscription: { tier: 'BUSINESS', status: 'ACTIVE' },
      settings: {
        readOnlyEnabled: false,
        readOnlyReason: null,
        rateLimitOverride: null,
      },
      _count: { branches: 3, businessUsers: 12, offlineDevices: 6 },
    });
    jest.spyOn(service as any, 'getBusinessHealth').mockResolvedValue({
      score: 71,
      offlineFailed: 2,
      exportsPending: 4,
      subscriptionStatus: 'ACTIVE',
    });
    prisma.supportAccessRequest.count.mockResolvedValue(5);
    prisma.exportJob.count.mockResolvedValue(4);
    prisma.subscriptionRequest.count.mockResolvedValue(1);
    prisma.offlineDevice.findMany.mockResolvedValue([
      { id: 'dev-1', status: 'ACTIVE', deviceName: 'Main POS', createdAt: new Date() },
    ]);
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'audit-1',
        action: 'BUSINESS_STATUS_UPDATE',
        outcome: 'SUCCESS',
        resourceType: 'Business',
        resourceId: 'biz-1',
        reason: 'manual review',
        requestId: 'req-1',
        sessionId: 'sess-1',
        correlationId: 'corr-1',
        createdAt: new Date('2026-02-09T09:00:00.000Z'),
      },
    ]);

    const workspace = await service.getBusinessWorkspace('biz-1');

    expect(workspace.business.id).toBe('biz-1');
    expect(workspace.counts).toEqual({
      branches: 3,
      users: 12,
      offlineDevices: 6,
    });
    expect(workspace.queues).toEqual({
      pendingSupport: 5,
      pendingExports: 4,
      pendingSubscriptionRequests: 1,
    });
    expect(workspace.recentAdminActions).toHaveLength(1);
  });

  it('throws for missing business preflight target', async () => {
    const { service, prisma } = buildService();
    prisma.business.findUnique.mockResolvedValue(null);

    await expect(
      service.getBusinessActionPreflight('missing-business', 'PURGE'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects cancel export for non-pending jobs', async () => {
    const { service, prisma } = buildService({
      exportJob: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    });
    prisma.exportJob.findUnique.mockResolvedValue({
      id: 'job-1',
      businessId: 'biz-1',
      status: 'RUNNING',
    });

    await expect(
      service.cancelExportJob({
        exportJobId: 'job-1',
        platformAdminId: 'admin-1',
        reason: 'operator cancel',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.exportJob.update).not.toHaveBeenCalled();
  });

  it('previews announcement audience by combining explicit and segment targets', async () => {
    const { service, prisma } = buildService({
      business: {
        findMany: jest.fn(),
      },
    });
    prisma.business.findMany
      .mockResolvedValueOnce([
        {
          id: 'biz-explicit',
          name: 'Alpha',
          status: 'ACTIVE',
          subscription: { tier: 'BUSINESS', status: 'ACTIVE' },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'biz-segment',
          name: 'Beta',
          status: 'ACTIVE',
          subscription: { tier: 'BUSINESS', status: 'TRIAL' },
        },
        {
          id: 'biz-explicit',
          name: 'Alpha',
          status: 'ACTIVE',
          subscription: { tier: 'BUSINESS', status: 'ACTIVE' },
        },
      ]);

    const preview = await service.previewAnnouncementAudience({
      targetBusinessIds: ['biz-explicit'],
      targetTiers: ['BUSINESS'],
      targetStatuses: ['ACTIVE'],
    });

    expect(preview.estimatedReach).toEqual({
      total: 2,
      explicit: 1,
      segment: 2,
    });
    expect(preview.filters).toEqual({
      hasBroadcastScope: false,
      targetBusinessIds: ['biz-explicit'],
      targetTiers: ['BUSINESS'],
      targetStatuses: ['ACTIVE'],
    });
    expect(preview.sampleBusinesses).toHaveLength(2);
  });

  it('records subscription purchase and computes lifecycle dates', async () => {
    const { service, prisma } = buildService({
      business: {
        findUnique: jest.fn(),
      },
    });
    prisma.business.findUnique.mockResolvedValue({
      id: 'biz-1',
      status: 'TRIAL',
    });
    const updateBusinessStatusSpy = jest
      .spyOn(service, 'updateBusinessStatus')
      .mockResolvedValue({} as any);
    const updateSubscriptionSpy = jest
      .spyOn(service, 'updateSubscription')
      .mockResolvedValue({ id: 'sub-1', status: 'ACTIVE' } as any);

    const result = await service.recordSubscriptionPurchase({
      businessId: 'biz-1',
      platformAdminId: 'admin-1',
      tier: 'BUSINESS' as any,
      durationDays: 30,
      startsAt: new Date('2026-02-10T00:00:00.000Z'),
      reason: 'Recorded purchase',
      expectedUpdatedAt: new Date('2026-02-10T00:00:00.000Z'),
      idempotencyKey: 'idem-purchase',
    });

    expect(updateBusinessStatusSpy).toHaveBeenCalledWith(
      'biz-1',
      'ACTIVE',
      'admin-1',
      'Recorded purchase',
      new Date('2026-02-10T00:00:00.000Z'),
      'idem-purchase',
    );
    expect(updateSubscriptionSpy).toHaveBeenCalledWith(
      'biz-1',
      expect.objectContaining({
        platformAdminId: 'admin-1',
        tier: 'BUSINESS',
        status: 'ACTIVE',
        trialEndsAt: null,
      }),
    );
    expect(result.lifecycle).toEqual(
      expect.objectContaining({
        startsAt: '2026-02-10T00:00:00.000Z',
        durationDays: 30,
        tier: 'BUSINESS',
      }),
    );
  });

  it('rejects subscription purchase for archived businesses', async () => {
    const { service, prisma } = buildService({
      business: {
        findUnique: jest.fn(),
      },
    });
    prisma.business.findUnique.mockResolvedValue({
      id: 'biz-9',
      status: 'ARCHIVED',
    });

    await expect(
      service.recordSubscriptionPurchase({
        businessId: 'biz-9',
        platformAdminId: 'admin-9',
        tier: 'BUSINESS' as any,
        durationDays: 30,
        reason: 'Recorded purchase',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
