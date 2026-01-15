import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { Public } from '../auth/public.decorator';
import { PlatformService } from './platform.service';
import { PlatformGuard } from './platform.guard';
import {
  BusinessStatus,
  SubscriptionStatus,
  SubscriptionTier,
} from '@prisma/client';
import { SupportAccessService } from '../support-access/support-access.service';

@Controller('platform')
export class PlatformController {
  constructor(
    private readonly authService: AuthService,
    private readonly platformService: PlatformService,
    private readonly supportAccessService: SupportAccessService,
  ) {}

  @Post('auth/login')
  @Public()
  async login(@Body() body: { email: string; password: string }) {
    return this.authService.signInPlatformAdmin(body.email, body.password);
  }

  @Post('auth/password')
  @UseGuards(PlatformGuard)
  async changePassword(
    @Req() req: { user?: { sub?: string } },
    @Body() body: { currentPassword: string; newPassword: string },
  ) {
    return this.platformService.changePlatformAdminPassword({
      platformAdminId: req.user?.sub || '',
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    });
  }

  @Post('businesses')
  @UseGuards(PlatformGuard)
  async createBusiness(
    @Body()
    body: {
      businessName: string;
      ownerName: string;
      ownerEmail: string;
      ownerTempPassword: string;
      tier?: SubscriptionTier;
    },
  ) {
    return this.platformService.provisionBusiness(body);
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
    @Body() body: { status: BusinessStatus; reason?: string },
  ) {
    return this.platformService.updateBusinessStatus(
      id,
      body.status,
      req.user?.sub || '',
      body.reason,
    );
  }

  @Patch('businesses/:id/read-only')
  @UseGuards(PlatformGuard)
  updateReadOnly(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body() body: { enabled: boolean; reason?: string },
  ) {
    return this.platformService.updateReadOnly(id, {
      enabled: body.enabled,
      reason: body.reason,
      platformAdminId: req.user?.sub || '',
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
    },
  ) {
    return this.platformService.updateSubscription(businessId, {
      platformAdminId: req.user?.sub || '',
      tier: body.tier,
      status: body.status,
      limits: body.limits,
      trialEndsAt: body.trialEndsAt ? new Date(body.trialEndsAt) : null,
      graceEndsAt: body.graceEndsAt ? new Date(body.graceEndsAt) : null,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      reason: body.reason,
    });
  }

  @Post('businesses/:id/purge')
  @UseGuards(PlatformGuard)
  purgeBusiness(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body()
    body: { reason?: string; confirmBusinessId?: string; confirmText?: string },
  ) {
    return this.platformService.purgeBusiness(
      id,
      req.user?.sub || '',
      body.reason,
      body.confirmBusinessId,
      body.confirmText,
    );
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
    },
  ) {
    return this.supportAccessService.createRequest({
      businessId: body.businessId,
      platformAdminId: req.user?.sub || '',
      reason: body.reason,
      scope: body.scope,
      durationHours: body.durationHours,
    });
  }

  @Get('support-access/requests')
  @UseGuards(PlatformGuard)
  listSupportRequests(
    @Req() req: { user?: { sub?: string } },
    @Query() query: { limit?: string; cursor?: string; status?: string },
  ) {
    return this.supportAccessService.listRequestsForPlatform(
      req.user?.sub || '',
      query,
    );
  }

  @Post('support-access/requests/:id/activate')
  @UseGuards(PlatformGuard)
  activateSupportRequest(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
  ) {
    return this.supportAccessService.activateRequest({
      requestId: id,
      platformAdminId: req.user?.sub || '',
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
      platformAdminId: req.user?.sub || '',
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
      platformAdminId: req.user?.sub || '',
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

  @Post('subscription-requests/:id/approve')
  @UseGuards(PlatformGuard)
  approveSubscriptionRequest(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body() body: { responseNote?: string },
  ) {
    return this.platformService.approveSubscriptionRequest({
      requestId: id,
      platformAdminId: req.user?.sub || '',
      responseNote: body.responseNote,
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
      platformAdminId: req.user?.sub || '',
      responseNote: body.responseNote,
    });
  }

  @Patch('businesses/:id/review')
  @UseGuards(PlatformGuard)
  updateReview(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body() body: { underReview: boolean; reason: string; severity?: string },
  ) {
    return this.platformService.updateBusinessReview({
      businessId: id,
      underReview: body.underReview,
      reason: body.reason,
      severity: body.severity,
      platformAdminId: req.user?.sub || '',
    });
  }

  @Post('businesses/:id/revoke-sessions')
  @UseGuards(PlatformGuard)
  revokeBusinessSessions(
    @Req() req: { user?: { sub?: string } },
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    return this.platformService.revokeBusinessSessions({
      businessId: id,
      platformAdminId: req.user?.sub || '',
      reason: body.reason,
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
    },
  ) {
    return this.platformService.updateRateLimits({
      businessId: id,
      platformAdminId: req.user?.sub || '',
      limit: body.limit ?? null,
      ttlSeconds: body.ttlSeconds ?? null,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      reason: body.reason,
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
      platformAdminId: req.user?.sub || '',
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
      platformAdminId: req.user?.sub || '',
      reason: body.reason,
      targetBusinessIds: body.targetBusinessIds,
      targetTiers: body.targetTiers,
      targetStatuses: body.targetStatuses,
    });
  }

  @Get('announcements')
  @UseGuards(PlatformGuard)
  listAnnouncements() {
    return this.platformService.listAnnouncements();
  }

  @Patch('announcements/:announcementId/end')
  @UseGuards(PlatformGuard)
  endAnnouncement(
    @Req() req: { user?: { sub?: string } },
    @Param('announcementId') announcementId: string,
  ) {
    return this.platformService.endAnnouncement({
      announcementId,
      platformAdminId: req.user?.sub || '',
    });
  }
}
