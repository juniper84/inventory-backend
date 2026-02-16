import { PlatformController } from './platform.controller';

describe('PlatformController', () => {
  const authService = {
    signInPlatformAdmin: jest.fn(),
    signInSupportAccess: jest.fn(),
  };

  const platformService = {
    changePlatformAdminPassword: jest.fn(),
    provisionBusiness: jest.fn(),
    listBusinesses: jest.fn(),
    getPlatformMetrics: jest.fn(),
    getOverviewSnapshot: jest.fn(),
    getHealthMatrix: jest.fn(),
    getQueuesSummary: jest.fn(),
    getBusinessWorkspace: jest.fn(),
    getBusinessActionPreflight: jest.fn(),
    getAuditTimeline: jest.fn(),
    listAuditLogs: jest.fn(),
    listPlatformAuditLogs: jest.fn(),
    updateBusinessStatus: jest.fn(),
    updateReadOnly: jest.fn(),
    updateSubscription: jest.fn(),
    recordSubscriptionPurchase: jest.fn(),
    purgeBusiness: jest.fn(),
    getPurgePreflight: jest.fn(),
    requestExportOnExit: jest.fn(),
    markExportDelivered: jest.fn(),
    listSubscriptionRequests: jest.fn(),
    listExportJobs: jest.fn(),
    getExportQueueStats: jest.fn(),
    retryExportJob: jest.fn(),
    requeueExportJob: jest.fn(),
    cancelExportJob: jest.fn(),
    listIncidents: jest.fn(),
    createIncident: jest.fn(),
    updateIncident: jest.fn(),
    transitionIncident: jest.fn(),
    addIncidentNote: jest.fn(),
    approveSubscriptionRequest: jest.fn(),
    rejectSubscriptionRequest: jest.fn(),
    updateBusinessReview: jest.fn(),
    revokeBusinessSessions: jest.fn(),
    updateRateLimits: jest.fn(),
    listSubscriptionHistory: jest.fn(),
    getBusinessHealth: jest.fn(),
    listOfflineDevices: jest.fn(),
    revokeOfflineDevice: jest.fn(),
    createAnnouncement: jest.fn(),
    previewAnnouncementAudience: jest.fn(),
    listAnnouncements: jest.fn(),
    endAnnouncement: jest.fn(),
  };

  const supportAccessService = {
    createRequest: jest.fn(),
    listRequestsForPlatform: jest.fn(),
    listSessionsForPlatform: jest.fn(),
    revokeSession: jest.fn(),
    activateRequest: jest.fn(),
  };

  let controller: PlatformController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new PlatformController(
      authService as any,
      platformService as any,
      supportAccessService as any,
    );
  });

  it('forwards platform login credentials to auth service', async () => {
    authService.signInPlatformAdmin.mockResolvedValue({ accessToken: 'token' });

    await controller.login({ email: 'admin@example.com', password: 'secret' });

    expect(authService.signInPlatformAdmin).toHaveBeenCalledWith(
      'admin@example.com',
      'secret',
    );
  });

  it('uses requester admin id for password change', async () => {
    await controller.changePassword(
      { user: { sub: 'admin-1' } },
      { currentPassword: 'old', newPassword: 'new' },
    );

    expect(platformService.changePlatformAdminPassword).toHaveBeenCalledWith({
      platformAdminId: 'admin-1',
      currentPassword: 'old',
      newPassword: 'new',
    });
  });

  it('coerces metrics query dates to Date', async () => {
    await controller.getMetrics({
      range: '7d',
      from: '2026-02-01T00:00:00.000Z',
      to: '2026-02-02T00:00:00.000Z',
    });

    expect(platformService.getPlatformMetrics).toHaveBeenCalledWith(
      '7d',
      new Date('2026-02-01T00:00:00.000Z'),
      new Date('2026-02-02T00:00:00.000Z'),
    );
  });

  it('forwards overview snapshot params with date coercion', async () => {
    await controller.getOverviewSnapshot({
      range: '24h',
      from: '2026-02-01T00:00:00.000Z',
      to: '2026-02-02T00:00:00.000Z',
    });

    expect(platformService.getOverviewSnapshot).toHaveBeenCalledWith({
      range: '24h',
      from: new Date('2026-02-01T00:00:00.000Z'),
      to: new Date('2026-02-02T00:00:00.000Z'),
    });
  });

  it('forwards business lifecycle mutations with safety metadata', async () => {
    await controller.updateBusinessStatus(
      { user: { sub: 'admin-1' } },
      'biz-1',
      {
        status: 'SUSPENDED' as any,
        reason: 'risk',
        expectedUpdatedAt: '2026-02-09T10:00:00.000Z',
        idempotencyKey: 'idem-status',
      },
    );
    await controller.updateReadOnly(
      { user: { sub: 'admin-1' } },
      'biz-1',
      {
        enabled: true,
        reason: 'investigation',
        expectedUpdatedAt: '2026-02-09T10:00:00.000Z',
        idempotencyKey: 'idem-ro',
      },
    );
    await controller.updateSubscription(
      { user: { sub: 'admin-1' } },
      'biz-1',
      {
        tier: 'BUSINESS' as any,
        status: 'ACTIVE' as any,
        trialEndsAt: '2026-02-20T00:00:00.000Z',
        graceEndsAt: '2026-02-25T00:00:00.000Z',
        expiresAt: '2026-03-01T00:00:00.000Z',
        reason: 'upgrade',
        expectedUpdatedAt: '2026-02-09T10:00:00.000Z',
        idempotencyKey: 'idem-sub',
      },
    );

    expect(platformService.updateBusinessStatus).toHaveBeenCalledWith(
      'biz-1',
      'SUSPENDED',
      'admin-1',
      'risk',
      new Date('2026-02-09T10:00:00.000Z'),
      'idem-status',
    );
    expect(platformService.updateReadOnly).toHaveBeenCalledWith('biz-1', {
      enabled: true,
      reason: 'investigation',
      platformAdminId: 'admin-1',
      expectedUpdatedAt: new Date('2026-02-09T10:00:00.000Z'),
      idempotencyKey: 'idem-ro',
    });
    expect(platformService.updateSubscription).toHaveBeenCalledWith(
      'biz-1',
      expect.objectContaining({
        platformAdminId: 'admin-1',
        trialEndsAt: new Date('2026-02-20T00:00:00.000Z'),
        graceEndsAt: new Date('2026-02-25T00:00:00.000Z'),
        expiresAt: new Date('2026-03-01T00:00:00.000Z'),
        expectedUpdatedAt: new Date('2026-02-09T10:00:00.000Z'),
      }),
    );
  });

  it('forwards subscription purchase payload with date coercion', async () => {
    await controller.recordSubscriptionPurchase(
      { user: { sub: 'admin-5' } },
      'biz-5',
      {
        tier: 'ENTERPRISE' as any,
        durationDays: 30,
        startsAt: '2026-02-10T00:00:00.000Z',
        reason: 'Manual purchase recorded',
        expectedUpdatedAt: '2026-02-10T00:00:00.000Z',
        idempotencyKey: 'idem-purchase',
      },
    );

    expect(platformService.recordSubscriptionPurchase).toHaveBeenCalledWith({
      businessId: 'biz-5',
      platformAdminId: 'admin-5',
      tier: 'ENTERPRISE',
      durationDays: 30,
      startsAt: new Date('2026-02-10T00:00:00.000Z'),
      reason: 'Manual purchase recorded',
      expectedUpdatedAt: new Date('2026-02-10T00:00:00.000Z'),
      idempotencyKey: 'idem-purchase',
    });
  });

  it('forwards purge and purge preflight payloads', async () => {
    await controller.purgeBusiness(
      { user: { sub: 'admin-2' } },
      'biz-2',
      {
        reason: 'request',
        confirmBusinessId: 'biz-2',
        confirmText: 'DELETE',
        dryRun: true,
        expectedUpdatedAt: '2026-02-09T11:00:00.000Z',
        idempotencyKey: 'idem-purge',
      },
    );
    await controller.purgeBusinessPreflight('biz-2', { reason: 'request' });

    expect(platformService.purgeBusiness).toHaveBeenCalledWith(
      'biz-2',
      'admin-2',
      'request',
      'biz-2',
      'DELETE',
      true,
      new Date('2026-02-09T11:00:00.000Z'),
      'idem-purge',
    );
    expect(platformService.getPurgePreflight).toHaveBeenCalledWith(
      'biz-2',
      'request',
    );
  });

  it('forwards support queue endpoints with requester context', async () => {
    await controller.createSupportRequest(
      { user: { sub: 'admin-3' } },
      {
        businessId: 'biz-3',
        reason: 'urgent help',
        scope: ['users'],
        durationHours: 6,
        severity: 'HIGH' as any,
        priority: 'URGENT' as any,
      },
    );
    await controller.listSupportRequests({ status: 'PENDING' });
    await controller.listSupportSessions({ activeOnly: 'true' });
    await controller.revokeSupportSession(
      { user: { sub: 'admin-3' } },
      'sess-1',
      { reason: 'done' },
    );
    await controller.activateSupportRequest({ user: { sub: 'admin-3' } }, 'req-1');

    expect(supportAccessService.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: 'biz-3',
        platformAdminId: 'admin-3',
        severity: 'HIGH',
        priority: 'URGENT',
      }),
    );
    expect(supportAccessService.listRequestsForPlatform).toHaveBeenCalledWith({
      status: 'PENDING',
    });
    expect(supportAccessService.listSessionsForPlatform).toHaveBeenCalledWith({
      activeOnly: 'true',
    });
    expect(supportAccessService.revokeSession).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      platformAdminId: 'admin-3',
      reason: 'done',
    });
    expect(supportAccessService.activateRequest).toHaveBeenCalledWith({
      requestId: 'req-1',
      platformAdminId: 'admin-3',
    });
  });

  it('forwards support login token to auth service', async () => {
    await controller.supportLogin({ token: 'support-token' });

    expect(authService.signInSupportAccess).toHaveBeenCalledWith('support-token');
  });

  it('forwards export queue actions', async () => {
    await controller.exportOnExit(
      { user: { sub: 'admin-4' } },
      { businessId: 'biz-4', reason: 'exit' },
    );
    await controller.markExportDelivered(
      { user: { sub: 'admin-4' } },
      'job-1',
      { deliveredAt: '2026-02-09T12:00:00.000Z', reason: 'emailed' },
    );
    await controller.retryExportJob(
      { user: { sub: 'admin-4' } },
      'job-1',
      { reason: 'retry' },
    );
    await controller.requeueExportJob(
      { user: { sub: 'admin-4' } },
      'job-1',
      { reason: 'requeue' },
    );
    await controller.cancelExportJob(
      { user: { sub: 'admin-4' } },
      'job-1',
      { reason: 'cancel' },
    );

    expect(platformService.requestExportOnExit).toHaveBeenCalledWith({
      businessId: 'biz-4',
      platformAdminId: 'admin-4',
      reason: 'exit',
    });
    expect(platformService.markExportDelivered).toHaveBeenCalledWith({
      exportJobId: 'job-1',
      platformAdminId: 'admin-4',
      deliveredAt: new Date('2026-02-09T12:00:00.000Z'),
      reason: 'emailed',
    });
    expect(platformService.retryExportJob).toHaveBeenCalledWith({
      exportJobId: 'job-1',
      platformAdminId: 'admin-4',
      reason: 'retry',
    });
    expect(platformService.requeueExportJob).toHaveBeenCalledWith({
      exportJobId: 'job-1',
      platformAdminId: 'admin-4',
      reason: 'requeue',
    });
    expect(platformService.cancelExportJob).toHaveBeenCalledWith({
      exportJobId: 'job-1',
      platformAdminId: 'admin-4',
      reason: 'cancel',
    });
  });

  it('forwards incident lifecycle actions', async () => {
    await controller.createIncident(
      { user: { sub: 'admin-5' } },
      {
        businessId: 'biz-5',
        reason: 'risk',
        title: 'High error rate',
        severity: 'HIGH' as any,
        ownerPlatformAdminId: 'admin-6',
        metadata: { source: 'api' },
      },
    );
    await controller.updateIncident(
      { user: { sub: 'admin-5' } },
      'inc-1',
      {
        title: 'Updated',
        reason: 'triage',
        severity: 'CRITICAL' as any,
        ownerPlatformAdminId: 'admin-7',
        status: 'INVESTIGATING' as any,
      },
    );
    await controller.transitionIncident(
      { user: { sub: 'admin-5' } },
      'inc-1',
      { toStatus: 'MITIGATED' as any, reason: 'patched', note: 'watching' },
    );
    await controller.addIncidentNote(
      { user: { sub: 'admin-5' } },
      'inc-1',
      { note: 'all good', metadata: { status: 'ok' } },
    );

    expect(platformService.createIncident).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: 'biz-5',
        platformAdminId: 'admin-5',
        severity: 'HIGH',
      }),
    );
    expect(platformService.updateIncident).toHaveBeenCalledWith(
      expect.objectContaining({
        incidentId: 'inc-1',
        platformAdminId: 'admin-5',
        status: 'INVESTIGATING',
      }),
    );
    expect(platformService.transitionIncident).toHaveBeenCalledWith({
      incidentId: 'inc-1',
      platformAdminId: 'admin-5',
      toStatus: 'MITIGATED',
      reason: 'patched',
      note: 'watching',
    });
    expect(platformService.addIncidentNote).toHaveBeenCalledWith({
      incidentId: 'inc-1',
      platformAdminId: 'admin-5',
      note: 'all good',
      metadata: { status: 'ok' },
    });
  });

  it('forwards announcement lifecycle actions', async () => {
    await controller.createAnnouncement(
      { user: { sub: 'admin-8' } },
      {
        title: 'Maintenance',
        message: 'Tonight',
        severity: 'WARN',
        startsAt: '2026-02-11T01:00:00.000Z',
        endsAt: '2026-02-11T03:00:00.000Z',
        reason: 'planned',
        targetBusinessIds: ['biz-1'],
        targetTiers: ['BUSINESS'],
        targetStatuses: ['ACTIVE'],
      },
    );
    await controller.previewAnnouncementAudience({
      targetBusinessIds: ['biz-1'],
      targetTiers: ['BUSINESS'],
      targetStatuses: ['ACTIVE'],
    });
    await controller.endAnnouncement({ user: { sub: 'admin-8' } }, 'ann-1');

    expect(platformService.createAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({
        platformAdminId: 'admin-8',
        startsAt: new Date('2026-02-11T01:00:00.000Z'),
        endsAt: new Date('2026-02-11T03:00:00.000Z'),
      }),
    );
    expect(platformService.previewAnnouncementAudience).toHaveBeenCalledWith({
      targetBusinessIds: ['biz-1'],
      targetTiers: ['BUSINESS'],
      targetStatuses: ['ACTIVE'],
    });
    expect(platformService.endAnnouncement).toHaveBeenCalledWith({
      announcementId: 'ann-1',
      platformAdminId: 'admin-8',
    });
  });

  it('forwards list/read endpoints to service dependencies', async () => {
    await controller.listBusinesses({ status: 'ACTIVE' });
    await controller.getHealthMatrix();
    await controller.getQueuesSummary();
    await controller.getBusinessWorkspace('biz-9');
    await controller.getBusinessActionPreflight('biz-9', 'PURGE');
    await controller.getAuditTimeline({ businessId: 'biz-9' });
    await controller.listAuditLogs({ businessId: 'biz-9' });
    await controller.listPlatformAuditLogs({ action: 'BUSINESS_STATUS_UPDATE' });
    await controller.listSubscriptionRequests({ status: 'PENDING' });
    await controller.listExportJobs({ status: 'FAILED' });
    await controller.getExportQueueStats({ type: 'OFF_EXIT' });
    await controller.listIncidents({ severity: 'HIGH' });
    await controller.listSubscriptionHistory('biz-9');
    await controller.getBusinessHealth('biz-9');
    await controller.listOfflineDevices('biz-9');
    await controller.revokeOfflineDevice(
      { user: { sub: 'admin-9' } },
      'device-1',
      { reason: 'lost' },
    );
    await controller.listAnnouncements();

    expect(platformService.listBusinesses).toHaveBeenCalledWith({
      status: 'ACTIVE',
    });
    expect(platformService.getBusinessWorkspace).toHaveBeenCalledWith('biz-9');
    expect(platformService.getBusinessActionPreflight).toHaveBeenCalledWith(
      'biz-9',
      'PURGE',
    );
    expect(platformService.listAuditLogs).toHaveBeenCalledWith('biz-9', {
      businessId: 'biz-9',
    });
    expect(platformService.revokeOfflineDevice).toHaveBeenCalledWith({
      deviceId: 'device-1',
      platformAdminId: 'admin-9',
      reason: 'lost',
    });
  });
});
