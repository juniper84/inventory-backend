import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from '../auth/auth.service';
import { Public } from '../auth/public.decorator';
import { PlatformService } from './platform.service';
import { PlatformGuard } from './platform.guard';
import { PlatformEventService } from './platform-event.service';
import {
  BusinessStatus,
  PlatformIncidentSeverity,
  PlatformIncidentStatus,
  SupportRequestPriority,
  SupportRequestSeverity,
  SubscriptionStatus,
  SubscriptionTier,
} from '@prisma/client';
import { SupportAccessService } from '../support-access/support-access.service';
import { requireUserId } from '../common/request-context';

@Controller('platform')
export class PlatformController {
  constructor(
    private readonly authService: AuthService,
    private readonly platformService: PlatformService,
    private readonly supportAccessService: SupportAccessService,
    private readonly platformEventService: PlatformEventService,
  ) {}

  @Post('auth/login')
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async login(@Body() body: { email: string; password: string }) {
    return this.authService.signInPlatformAdmin(body.email, body.password);
  }

  @Post('auth/refresh')
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async refresh(@Body() body: { refreshToken: string }) {
    return this.authService.refreshPlatformAdminToken(body.refreshToken);
  }

  @Post('auth/logout')
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async logout(@Body() body: { refreshToken?: string }) {
    if (body.refreshToken) {
      await this.authService.logoutPlatformAdmin(body.refreshToken);
    }
    return { success: true };
  }

  @Post('auth/password')
  @UseGuards(PlatformGuard)
  async changePassword(
    @Req() req: { user?: { sub?: string } },
    @Body() body: { currentPassword: string; newPassword: string },
  ) {
    return this.platformService.changePlatformAdminPassword({
      platformAdminId: requireUserId(req),
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    });
  }

  @Post('businesses')
  @UseGuards(PlatformGuard)
  async createBusiness(
    @Req() req: { user?: { sub?: string } },
    @Body()
    body: {
      businessName: string;
      ownerName: string;
      ownerEmail: string;
      ownerTempPassword: string;
      tier?: SubscriptionTier;
    },
  ) {
    return this.platformService.provisionBusiness({ ...body, actorId: requireUserId(req) });
  }

  @Get('businesses')
  @UseGuards(PlatformGuard)
  listBusinesses(
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      status?: string;
      search?: string;
    },
  ) {
    return this.platformService.listBusinesses(query);
  }

  @Get('businesses/counts')
  @UseGuards(PlatformGuard)
  getBusinessesCounts() {
    return this.platformService.getBusinessesCounts();
  }

  @Get('businesses/:id/exports')
  @UseGuards(PlatformGuard)
  listBusinessExports(
    @Param('id') id: string,
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      status?: string;
      type?: string;
    },
  ) {
    return this.platformService.listExportJobs({ ...query, businessId: id });
  }

  @Get('businesses/:id/activity-heatmap')
  @UseGuards(PlatformGuard)
  getBusinessActivityHeatmap(
    @Param('id') id: string,
    @Query() query: { days?: string },
  ) {
    const days = Math.max(1, Math.min(365, parseInt(query.days ?? '90', 10) || 90));
    return this.platformService.getBusinessActivityHeatmap(id, days);
  }

  @Post('businesses/bulk-action')
  @UseGuards(PlatformGuard)
  bulkBusinessAction(
    @Req() req: { user?: { sub?: string } },
    @Body()
    body: {
      businessIds: string[];
      action: 'SUSPEND' | 'EXTEND_TRIAL' | 'READ_ONLY' | 'ARCHIVE';
      params?: { days?: number; reason?: string; enabled?: boolean };
    },
  ) {
    return this.platformService.bulkBusinessAction({
      businessIds: body.businessIds,
      action: body.action,
      params: body.params ?? {},
      platformAdminId: requireUserId(req),
    });
  }

  @Get('metrics')
  @UseGuards(PlatformGuard)
  getMetrics(
    @Query()
    query: {
      range?: string;
      from?: string;
      to?: string;
    },
  ) {
    return this.platformService.getPlatformMetrics(
      (query.range as any) ?? '24h',
      query.from ? new Date(query.from) : null,
      query.to ? new Date(query.to) : null,
    );
  }

  @Get('overview/snapshot')
  @UseGuards(PlatformGuard)
  getOverviewSnapshot(
    @Query()
    query: {
      range?: string;
      from?: string;
      to?: string;
    },
  ) {
    return this.platformService.getOverviewSnapshot({
      range: (query.range as any) ?? '24h',
      from: query.from ? new Date(query.from) : null,
      to: query.to ? new Date(query.to) : null,
    });
  }

  @Get('health/matrix')
  @UseGuards(PlatformGuard)
  getHealthMatrix() {
    return this.platformService.getHealthMatrix();
  }

  @Get('queues/summary')
  @UseGuards(PlatformGuard)
  getQueuesSummary() {
    return this.platformService.getQueuesSummary();
  }

  @Get('businesses/orphans')
  @UseGuards(PlatformGuard)
  findOrphanBusinesses() {
    return this.platformService.findOrphanBusinesses();
  }

  @Get('businesses/:businessId/workspace')
  @UseGuards(PlatformGuard)
  getBusinessWorkspace(@Param('businessId') businessId: string) {
    return this.platformService.getBusinessWorkspace(businessId);
  }

  @Get('businesses/:businessId/actions/:action/preflight')
  @UseGuards(PlatformGuard)
  getBusinessActionPreflight(
    @Param('businessId') businessId: string,
    @Param('action') action: string,
  ) {
    return this.platformService.getBusinessActionPreflight(businessId, action);
  }

  @Get('audit-logs/timeline')
  @UseGuards(PlatformGuard)
  getAuditTimeline(
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      businessId?: string;
      action?: string;
      resourceType?: string;
      outcome?: string;
      correlationId?: string;
      requestId?: string;
      sessionId?: string;
      from?: string;
      to?: string;
    },
  ) {
    return this.platformService.getAuditTimeline(query);
  }

  @Get('audit-logs')
  @UseGuards(PlatformGuard)
  listAuditLogs(
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      businessId?: string;
      action?: string;
      resourceType?: string;
      outcome?: string;
      resourceId?: string;
      correlationId?: string;
      requestId?: string;
      sessionId?: string;
      deviceId?: string;
    },
  ) {
    return this.platformService.listAuditLogs(query.businessId, query);
  }

  @Get('platform-audit-logs')
  @UseGuards(PlatformGuard)
  listPlatformAuditLogs(
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      action?: string;
      resourceType?: string;
      resourceId?: string;
      platformAdminId?: string;
    },
  ) {
    return this.platformService.listPlatformAuditLogs(query);
  }

  @Patch('businesses/:id/status')
  @UseGuards(PlatformGuard)
  updateBusinessStatus(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body()
    body: {
      status: BusinessStatus;
      reason?: string;
      expectedUpdatedAt?: string;
      idempotencyKey?: string;
    },
  ) {
    return this.platformService.updateBusinessStatus(
      id,
      body.status,
      requireUserId(req),
      body.reason,
      body.expectedUpdatedAt ? new Date(body.expectedUpdatedAt) : null,
      body.idempotencyKey,
    );
  }

  @Patch('businesses/:id/read-only')
  @UseGuards(PlatformGuard)
  updateReadOnly(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body()
    body: {
      enabled: boolean;
      reason?: string;
      expectedUpdatedAt?: string;
      idempotencyKey?: string;
    },
  ) {
    return this.platformService.updateReadOnly(id, {
      enabled: body.enabled,
      reason: body.reason,
      platformAdminId: requireUserId(req),
      expectedUpdatedAt: body.expectedUpdatedAt
        ? new Date(body.expectedUpdatedAt)
        : null,
      idempotencyKey: body.idempotencyKey,
    });
  }

  @Patch('subscriptions/:businessId')
  @UseGuards(PlatformGuard)
  updateSubscription(
    @Req() req: { user?: { sub?: string } },
    @Param('businessId') businessId: string,
    @Body()
    body: {
      tier?: SubscriptionTier;
      status?: SubscriptionStatus;
      limits?: Record<string, number | string | boolean | null> | null;
      trialEndsAt?: string | null;
      graceEndsAt?: string | null;
      expiresAt?: string | null;
      reason?: string;
      expectedUpdatedAt?: string;
      idempotencyKey?: string;
    },
  ) {
    return this.platformService.updateSubscription(businessId, {
      platformAdminId: requireUserId(req),
      tier: body.tier,
      status: body.status,
      limits: body.limits,
      trialEndsAt: body.trialEndsAt ? new Date(body.trialEndsAt) : null,
      graceEndsAt: body.graceEndsAt ? new Date(body.graceEndsAt) : null,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      reason: body.reason,
      expectedUpdatedAt: body.expectedUpdatedAt
        ? new Date(body.expectedUpdatedAt)
        : null,
      idempotencyKey: body.idempotencyKey,
    });
  }

  @Post('subscriptions/:businessId/purchase')
  @UseGuards(PlatformGuard)
  recordSubscriptionPurchase(
    @Req() req: { user?: { sub?: string } },
    @Param('businessId') businessId: string,
    @Body()
    body: {
      tier: SubscriptionTier;
      months: number;
      startsAt?: string | null;
      isPaid?: boolean;
      amountDue?: number;
      reason?: string;
      expectedUpdatedAt?: string;
      idempotencyKey?: string;
    },
  ) {
    return this.platformService.recordSubscriptionPurchase({
      businessId,
      platformAdminId: requireUserId(req),
      tier: body.tier,
      months: body.months,
      startsAt: body.startsAt ? new Date(body.startsAt) : null,
      isPaid: body.isPaid,
      amountDue: body.amountDue,
      reason: body.reason,
      expectedUpdatedAt: body.expectedUpdatedAt
        ? new Date(body.expectedUpdatedAt)
        : null,
      idempotencyKey: body.idempotencyKey,
    });
  }

  @Get('subscriptions/:businessId/purchases')
  @UseGuards(PlatformGuard)
  getSubscriptionPurchases(
    @Param('businessId') businessId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.platformService.getSubscriptionPurchases(businessId, {
      limit: limit ? parseInt(limit, 10) : undefined,
      cursor,
    });
  }

  @Post('businesses/:id/purge')
  @UseGuards(PlatformGuard)
  purgeBusiness(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body()
    body: {
      reason?: string;
      confirmBusinessId?: string;
      confirmText?: string;
      dryRun?: boolean;
      expectedUpdatedAt?: string;
      idempotencyKey?: string;
    },
  ) {
    return this.platformService.purgeBusiness(
      id,
      requireUserId(req),
      body.reason,
      body.confirmBusinessId,
      body.confirmText,
      body.dryRun,
      body.expectedUpdatedAt ? new Date(body.expectedUpdatedAt) : null,
      body.idempotencyKey,
    );
  }

  @Post('businesses/:id/purge-preflight')
  @UseGuards(PlatformGuard)
  purgeBusinessPreflight(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return this.platformService.getPurgePreflight(id, requireUserId(req), body.reason);
  }

  @Post('support-access/requests')
  @UseGuards(PlatformGuard)
  createSupportRequest(
    @Req() req: { user?: { sub?: string } },
    @Body()
    body: {
      businessId: string;
      reason: string;
      scope?: string[];
      durationHours?: number;
      severity?: SupportRequestSeverity;
      priority?: SupportRequestPriority;
    },
  ) {
    return this.supportAccessService.createRequest({
      businessId: body.businessId,
      platformAdminId: requireUserId(req),
      reason: body.reason,
      scope: body.scope,
      durationHours: body.durationHours,
      severity: body.severity,
      priority: body.priority,
    });
  }

  @Get('support-access/requests')
  @UseGuards(PlatformGuard)
  listSupportRequests(
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      status?: string;
      businessId?: string;
      platformAdminId?: string;
      severity?: string;
      priority?: string;
      requestedFrom?: string;
      requestedTo?: string;
    },
  ) {
    return this.supportAccessService.listRequestsForPlatform(query);
  }

  @Get('support-access/sessions')
  @UseGuards(PlatformGuard)
  listSupportSessions(
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      businessId?: string;
      platformAdminId?: string;
      activeOnly?: string;
      requestId?: string;
    },
  ) {
    return this.supportAccessService.listSessionsForPlatform(query);
  }

  @Post('support-access/sessions/:id/revoke')
  @UseGuards(PlatformGuard)
  revokeSupportSession(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    return this.supportAccessService.revokeSession({
      sessionId: id,
      platformAdminId: requireUserId(req),
      reason: body.reason,
    });
  }

  @Post('support-access/sessions/:id/extend')
  @UseGuards(PlatformGuard)
  extendSupportSession(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body() body: { additionalHours: number; reason: string },
  ) {
    return this.supportAccessService.extendSession({
      sessionId: id,
      platformAdminId: requireUserId(req),
      additionalHours: Number(body.additionalHours),
      reason: body.reason,
    });
  }

  @Post('support-access/requests/:id/activate')
  @UseGuards(PlatformGuard)
  activateSupportRequest(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
  ) {
    return this.supportAccessService.activateRequest({
      requestId: id,
      platformAdminId: requireUserId(req),
    });
  }

  @Post('support-access/login')
  @UseGuards(PlatformGuard)
  async supportLogin(@Body() body: { token: string }) {
    return this.authService.signInSupportAccess(body.token);
  }

  @Post('exports/on-exit')
  @UseGuards(PlatformGuard)
  exportOnExit(
    @Req() req: { user?: { sub?: string } },
    @Body() body: { businessId: string; reason?: string },
  ) {
    return this.platformService.requestExportOnExit({
      businessId: body.businessId,
      platformAdminId: requireUserId(req),
      reason: body.reason,
    });
  }

  @Patch('exports/:id/delivered')
  @UseGuards(PlatformGuard)
  markExportDelivered(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body() body: { deliveredAt?: string; reason?: string },
  ) {
    return this.platformService.markExportDelivered({
      exportJobId: id,
      platformAdminId: requireUserId(req),
      deliveredAt: body.deliveredAt ? new Date(body.deliveredAt) : undefined,
      reason: body.reason,
    });
  }

  @Get('subscription-requests')
  @UseGuards(PlatformGuard)
  listSubscriptionRequests(
    @Query() query: { limit?: string; cursor?: string; status?: string },
  ) {
    return this.platformService.listSubscriptionRequests(query);
  }

  @Get('exports/jobs')
  @UseGuards(PlatformGuard)
  listExportJobs(
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      businessId?: string;
      status?: string;
      type?: string;
    },
  ) {
    return this.platformService.listExportJobs(query);
  }

  @Get('exports/stats')
  @UseGuards(PlatformGuard)
  getExportQueueStats(
    @Query()
    query: {
      businessId?: string;
      type?: string;
    },
  ) {
    return this.platformService.getExportQueueStats(query);
  }

  @Post('exports/:id/retry')
  @UseGuards(PlatformGuard)
  retryExportJob(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return this.platformService.retryExportJob({
      exportJobId: id,
      platformAdminId: requireUserId(req),
      reason: body.reason,
    });
  }

  @Post('exports/:id/requeue')
  @UseGuards(PlatformGuard)
  requeueExportJob(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return this.platformService.requeueExportJob({
      exportJobId: id,
      platformAdminId: requireUserId(req),
      reason: body.reason,
    });
  }

  @Post('exports/:id/cancel')
  @UseGuards(PlatformGuard)
  cancelExportJob(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return this.platformService.cancelExportJob({
      exportJobId: id,
      platformAdminId: requireUserId(req),
      reason: body.reason,
    });
  }

  @Get('incidents')
  @UseGuards(PlatformGuard)
  listIncidents(
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      businessId?: string;
      status?: string;
      severity?: string;
    },
  ) {
    return this.platformService.listIncidents(query);
  }

  @Post('incidents')
  @UseGuards(PlatformGuard)
  createIncident(
    @Req() req: { user?: { sub?: string } },
    @Body()
    body: {
      businessId: string;
      reason: string;
      title?: string;
      severity?: PlatformIncidentSeverity;
      ownerPlatformAdminId?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    return this.platformService.createIncident({
      businessId: body.businessId,
      reason: body.reason,
      title: body.title,
      severity: body.severity,
      ownerPlatformAdminId: body.ownerPlatformAdminId,
      metadata: body.metadata,
      platformAdminId: requireUserId(req),
    });
  }

  @Patch('incidents/:id')
  @UseGuards(PlatformGuard)
  updateIncident(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body()
    body: {
      title?: string;
      reason?: string;
      severity?: PlatformIncidentSeverity;
      ownerPlatformAdminId?: string | null;
      status?: PlatformIncidentStatus;
    },
  ) {
    return this.platformService.updateIncident({
      incidentId: id,
      platformAdminId: requireUserId(req),
      title: body.title,
      reason: body.reason,
      severity: body.severity,
      ownerPlatformAdminId: body.ownerPlatformAdminId,
      status: body.status,
    });
  }

  @Post('incidents/:id/transition')
  @UseGuards(PlatformGuard)
  transitionIncident(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body()
    body: {
      toStatus: PlatformIncidentStatus;
      reason: string;
      note?: string;
    },
  ) {
    return this.platformService.transitionIncident({
      incidentId: id,
      platformAdminId: requireUserId(req),
      toStatus: body.toStatus,
      reason: body.reason,
      note: body.note,
    });
  }

  @Post('incidents/:id/note')
  @UseGuards(PlatformGuard)
  addIncidentNote(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body() body: { note: string; metadata?: Record<string, unknown> },
  ) {
    return this.platformService.addIncidentNote({
      incidentId: id,
      platformAdminId: requireUserId(req),
      note: body.note,
      metadata: body.metadata,
    });
  }

  @Post('subscription-requests/:id/approve')
  @UseGuards(PlatformGuard)
  approveSubscriptionRequest(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body() body: {
      responseNote?: string;
      durationMonths?: number;
      isPaid?: boolean;
      amountDue?: number;
    },
  ) {
    return this.platformService.approveSubscriptionRequest({
      requestId: id,
      platformAdminId: requireUserId(req),
      responseNote: body.responseNote,
      durationMonths: body.durationMonths,
      isPaid: body.isPaid,
      amountDue: body.amountDue,
    });
  }

  @Post('subscription-requests/:id/reject')
  @UseGuards(PlatformGuard)
  rejectSubscriptionRequest(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body() body: { responseNote?: string },
  ) {
    return this.platformService.rejectSubscriptionRequest({
      requestId: id,
      platformAdminId: requireUserId(req),
      responseNote: body.responseNote,
    });
  }

  @Patch('businesses/:id/review')
  @UseGuards(PlatformGuard)
  updateReview(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body()
    body: {
      underReview: boolean;
      reason: string;
      severity?: string;
      expectedUpdatedAt?: string;
      idempotencyKey?: string;
    },
  ) {
    return this.platformService.updateBusinessReview({
      businessId: id,
      underReview: body.underReview,
      reason: body.reason,
      severity: body.severity,
      platformAdminId: requireUserId(req),
      expectedUpdatedAt: body.expectedUpdatedAt
        ? new Date(body.expectedUpdatedAt)
        : null,
      idempotencyKey: body.idempotencyKey,
    });
  }

  @Post('businesses/:id/revoke-sessions')
  @UseGuards(PlatformGuard)
  revokeBusinessSessions(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body()
    body: {
      reason: string;
      expectedUpdatedAt?: string;
      idempotencyKey?: string;
    },
  ) {
    return this.platformService.revokeBusinessSessions({
      businessId: id,
      platformAdminId: requireUserId(req),
      reason: body.reason,
      expectedUpdatedAt: body.expectedUpdatedAt
        ? new Date(body.expectedUpdatedAt)
        : null,
      idempotencyKey: body.idempotencyKey,
    });
  }

  @Patch('businesses/:id/rate-limits')
  @UseGuards(PlatformGuard)
  updateRateLimits(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body()
    body: {
      limit?: number | null;
      ttlSeconds?: number | null;
      expiresAt?: string | null;
      reason: string;
      expectedUpdatedAt?: string;
      idempotencyKey?: string;
    },
  ) {
    return this.platformService.updateRateLimits({
      businessId: id,
      platformAdminId: requireUserId(req),
      limit: body.limit ?? null,
      ttlSeconds: body.ttlSeconds ?? null,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      reason: body.reason,
      expectedUpdatedAt: body.expectedUpdatedAt
        ? new Date(body.expectedUpdatedAt)
        : null,
      idempotencyKey: body.idempotencyKey,
    });
  }

  @Get('subscriptions/:businessId/history')
  @UseGuards(PlatformGuard)
  listSubscriptionHistory(@Param('businessId') businessId: string) {
    return this.platformService.listSubscriptionHistory(businessId);
  }

  @Get('businesses/:businessId/health')
  @UseGuards(PlatformGuard)
  getBusinessHealth(@Param('businessId') businessId: string) {
    return this.platformService.getBusinessHealth(businessId);
  }

  @Get('businesses/:businessId/devices')
  @UseGuards(PlatformGuard)
  listOfflineDevices(@Param('businessId') businessId: string) {
    return this.platformService.listOfflineDevices(businessId);
  }

  @Post('devices/:deviceId/revoke')
  @UseGuards(PlatformGuard)
  revokeOfflineDevice(
    @Req() req: { user?: { sub?: string } },
    @Param('deviceId') deviceId: string,
    @Body() body: { reason: string },
  ) {
    return this.platformService.revokeOfflineDevice({
      deviceId,
      platformAdminId: requireUserId(req),
      reason: body.reason,
    });
  }

  @Post('announcements')
  @UseGuards(PlatformGuard)
  createAnnouncement(
    @Req() req: { user?: { sub?: string } },
    @Body()
    body: {
      title: string;
      message: string;
      severity: string;
      startsAt?: string;
      endsAt?: string | null;
      reason?: string;
      targetBusinessIds?: string[];
      targetTiers?: string[];
      targetStatuses?: string[];
    },
  ) {
    return this.platformService.createAnnouncement({
      title: body.title,
      message: body.message,
      severity: body.severity,
      startsAt: body.startsAt ? new Date(body.startsAt) : undefined,
      endsAt: body.endsAt ? new Date(body.endsAt) : null,
      platformAdminId: requireUserId(req),
      reason: body.reason,
      targetBusinessIds: body.targetBusinessIds,
      targetTiers: body.targetTiers,
      targetStatuses: body.targetStatuses,
    });
  }

  @Patch('announcements/:announcementId')
  @UseGuards(PlatformGuard)
  updateAnnouncement(
    @Req() req: { user?: { sub?: string } },
    @Param('announcementId') announcementId: string,
    @Body()
    body: {
      title?: string;
      message?: string;
      severity?: string;
      reason?: string | null;
      startsAt?: string | null;
      endsAt?: string | null;
      targetBusinessIds?: string[];
      targetTiers?: string[];
      targetStatuses?: string[];
    },
  ) {
    return this.platformService.updateAnnouncement({
      announcementId,
      platformAdminId: requireUserId(req),
      title: body.title,
      message: body.message,
      severity: body.severity,
      reason: body.reason,
      startsAt:
        body.startsAt === undefined
          ? undefined
          : body.startsAt === null
            ? null
            : new Date(body.startsAt),
      endsAt:
        body.endsAt === undefined
          ? undefined
          : body.endsAt === null
            ? null
            : new Date(body.endsAt),
      targetBusinessIds: body.targetBusinessIds,
      targetTiers: body.targetTiers,
      targetStatuses: body.targetStatuses,
    });
  }

  @Delete('announcements/:announcementId')
  @UseGuards(PlatformGuard)
  deleteAnnouncement(
    @Req() req: { user?: { sub?: string } },
    @Param('announcementId') announcementId: string,
  ) {
    return this.platformService.deleteAnnouncement({
      announcementId,
      platformAdminId: requireUserId(req),
    });
  }

  @Post('announcements/preview')
  @UseGuards(PlatformGuard)
  previewAnnouncementAudience(
    @Body()
    body: {
      targetBusinessIds?: string[];
      targetTiers?: string[];
      targetStatuses?: string[];
    },
  ) {
    return this.platformService.previewAnnouncementAudience({
      targetBusinessIds: body.targetBusinessIds,
      targetTiers: body.targetTiers,
      targetStatuses: body.targetStatuses,
    });
  }

  @Get('announcements')
  @UseGuards(PlatformGuard)
  listAnnouncements(
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      status?: 'active' | 'upcoming' | 'ended';
      severity?: string;
    },
  ) {
    return this.platformService.listAnnouncements(query);
  }

  @Patch('announcements/:announcementId/end')
  @UseGuards(PlatformGuard)
  endAnnouncement(
    @Req() req: { user?: { sub?: string } },
    @Param('announcementId') announcementId: string,
  ) {
    return this.platformService.endAnnouncement({
      announcementId,
      platformAdminId: requireUserId(req),
    });
  }

  // ─── BUSINESS NOTES ────────────────────────────────────────────────────────

  @Post('businesses/:id/notes')
  @UseGuards(PlatformGuard)
  createBusinessNote(
    @Req() req: { user?: { sub?: string } },
    @Param('id') businessId: string,
    @Body() body: { body: string },
  ) {
    return this.platformService.createBusinessNote({
      businessId,
      platformAdminId: requireUserId(req),
      body: body.body,
    });
  }

  @Get('businesses/:id/notes')
  @UseGuards(PlatformGuard)
  listBusinessNotes(
    @Param('id') businessId: string,
    @Query() query: { limit?: string; cursor?: string },
  ) {
    return this.platformService.listBusinessNotes(businessId, {
      limit: query.limit ?? '20',
      cursor: query.cursor,
    });
  }

  @Delete('businesses/:id/notes/:noteId')
  @UseGuards(PlatformGuard)
  deleteBusinessNote(
    @Req() req: { user?: { sub?: string } },
    @Param('id') _businessId: string,
    @Param('noteId') noteId: string,
  ) {
    return this.platformService.deleteBusinessNote({
      noteId,
      platformAdminId: requireUserId(req),
    });
  }

  // ─── SCHEDULED ACTIONS ─────────────────────────────────────────────────────

  @Post('businesses/:id/scheduled-actions')
  @UseGuards(PlatformGuard)
  createScheduledAction(
    @Req() req: { user?: { sub?: string } },
    @Param('id') businessId: string,
    @Body() body: { actionType: string; payload: Record<string, unknown>; scheduledFor: string },
  ) {
    return this.platformService.createScheduledAction({
      businessId,
      platformAdminId: requireUserId(req),
      actionType: body.actionType,
      payload: body.payload,
      scheduledFor: body.scheduledFor,
    });
  }

  @Get('businesses/:id/scheduled-actions')
  @UseGuards(PlatformGuard)
  listScheduledActions(@Param('id') businessId: string) {
    return this.platformService.listScheduledActions(businessId);
  }

  @Delete('businesses/:id/scheduled-actions/:actionId')
  @UseGuards(PlatformGuard)
  cancelScheduledAction(
    @Req() req: { user?: { sub?: string } },
    @Param('id') _businessId: string,
    @Param('actionId') actionId: string,
  ) {
    return this.platformService.cancelScheduledAction({
      actionId,
      platformAdminId: requireUserId(req),
    });
  }

  // ─── ANALYTICS ──────────────────────────────────────────────────────────────

  @Get('analytics/revenue')
  @UseGuards(PlatformGuard)
  getAnalyticsRevenue(@Query('range') range?: string) {
    return this.platformService.getAnalyticsRevenue(range ?? '30d');
  }

  @Get('analytics/cohorts')
  @UseGuards(PlatformGuard)
  getAnalyticsCohorts() {
    return this.platformService.getAnalyticsCohorts();
  }

  @Get('analytics/churn')
  @UseGuards(PlatformGuard)
  getAnalyticsChurn(@Query('range') range?: string) {
    return this.platformService.getAnalyticsChurn(range ?? '30d');
  }

  @Get('analytics/conversions')
  @UseGuards(PlatformGuard)
  getAnalyticsConversions() {
    return this.platformService.getAnalyticsConversions();
  }

  @Get('analytics/purchases')
  @UseGuards(PlatformGuard)
  getAnalyticsPurchases(
    @Query('isPaid') isPaid?: string,
    @Query('tier') tier?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.platformService.getAnalyticsPurchases({
      isPaid: isPaid !== undefined ? isPaid === 'true' : undefined,
      tier: tier || undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      cursor,
    });
  }

  // ─── GLOBAL SEARCH ──────────────────────────────────────────────────────────

  @Get('search')
  @UseGuards(PlatformGuard)
  searchPlatform(@Query('q') q: string, @Query('types') types?: string) {
    const typeList = types ? types.split(',') : ['businesses', 'incidents', 'announcements'];
    return this.platformService.searchPlatform(q ?? '', typeList);
  }

  // ─── ONBOARDING ─────────────────────────────────────────────────────────────

  @Get('businesses/:businessId/onboarding')
  @UseGuards(PlatformGuard)
  getBusinessOnboarding(@Param('businessId') businessId: string) {
    return this.platformService.getBusinessOnboarding(businessId);
  }

  // ─── REAL-TIME EVENT STREAM ─────────────────────────────────────────────────

  @Sse('events')
  @Public()
  streamPlatformEvents(@Query('token') token: string) {
    return this.platformEventService.createStream(token ?? '');
  }
}
