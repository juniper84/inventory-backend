import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessService } from '../business/business.service';
import { UsersService } from '../users/users.service';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationStreamService } from '../notifications/notification-stream.service';
import {
  hashPassword,
  validatePassword,
  verifyPassword,
} from '../auth/password';
import {
  BusinessStatus,
  ExportJobStatus,
  ExportJobType,
  Prisma,
  PlatformAnnouncementSegmentType,
  PlatformIncidentSeverity,
  PlatformIncidentStatus,
  SubscriptionRequestStatus,
  SubscriptionRequestType,
  SubscriptionStatus,
  SubscriptionTier,
} from '@prisma/client';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';
import {
  claimIdempotency,
  finalizeIdempotency,
} from '../common/idempotency';
import { resolveResourceName } from '../common/resource-labels';
import {
  DEFAULT_APPROVAL_DEFAULTS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_POS_POLICIES,
  DEFAULT_STOCK_POLICIES,
  DEFAULT_LOCALE_SETTINGS,
} from '../settings/defaults';

type MetricsRange = '24h' | '7d' | '30d' | 'custom';
type MetricsSeriesPoint = {
  label: string;
  errorRate: number;
  avgLatency: number;
  offlineFailed: number;
  exportsPending: number;
};
type QueueStatusCounts = Record<string, number>;
type QueueSummary = {
  support: {
    total: number;
    byStatus: QueueStatusCounts;
  };
  exports: {
    total: number;
    byStatus: QueueStatusCounts;
  };
  subscriptions: {
    total: number;
    byStatus: QueueStatusCounts;
  };
};

const RANGE_CONFIG: Record<
  Exclude<MetricsRange, 'custom'>,
  { hours: number; bucketHours: number }
> = {
  '24h': { hours: 24, bucketHours: 1 },
  '7d': { hours: 24 * 7, bucketHours: 24 },
  '30d': { hours: 24 * 30, bucketHours: 24 },
};

const BUSINESS_STATUS_TRANSITIONS: Record<BusinessStatus, Set<BusinessStatus>> = {
  TRIAL: new Set([
    BusinessStatus.ACTIVE,
    BusinessStatus.GRACE,
    BusinessStatus.EXPIRED,
    BusinessStatus.SUSPENDED,
    BusinessStatus.ARCHIVED,
  ]),
  ACTIVE: new Set([
    BusinessStatus.GRACE,
    BusinessStatus.EXPIRED,
    BusinessStatus.SUSPENDED,
    BusinessStatus.ARCHIVED,
  ]),
  GRACE: new Set([
    BusinessStatus.ACTIVE,
    BusinessStatus.EXPIRED,
    BusinessStatus.SUSPENDED,
    BusinessStatus.ARCHIVED,
  ]),
  EXPIRED: new Set([
    BusinessStatus.ACTIVE,
    BusinessStatus.GRACE,
    BusinessStatus.SUSPENDED,
    BusinessStatus.ARCHIVED,
  ]),
  SUSPENDED: new Set([
    BusinessStatus.ACTIVE,
    BusinessStatus.GRACE,
    BusinessStatus.EXPIRED,
    BusinessStatus.ARCHIVED,
  ]),
  ARCHIVED: new Set([BusinessStatus.DELETED]),
  DELETED: new Set(),
};

const INCIDENT_STATUS_TRANSITIONS: Record<
  PlatformIncidentStatus,
  Set<PlatformIncidentStatus>
> = {
  OPEN: new Set([
    PlatformIncidentStatus.INVESTIGATING,
    PlatformIncidentStatus.MITIGATED,
    PlatformIncidentStatus.RESOLVED,
    PlatformIncidentStatus.CLOSED,
  ]),
  INVESTIGATING: new Set([
    PlatformIncidentStatus.MITIGATED,
    PlatformIncidentStatus.RESOLVED,
    PlatformIncidentStatus.CLOSED,
  ]),
  MITIGATED: new Set([
    PlatformIncidentStatus.INVESTIGATING,
    PlatformIncidentStatus.RESOLVED,
    PlatformIncidentStatus.CLOSED,
  ]),
  RESOLVED: new Set([PlatformIncidentStatus.CLOSED, PlatformIncidentStatus.INVESTIGATING]),
  CLOSED: new Set([PlatformIncidentStatus.INVESTIGATING]),
};

@Injectable()
export class PlatformService {
  constructor(
    private readonly businessService: BusinessService,
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    private readonly notificationStream: NotificationStreamService,
    private readonly configService: ConfigService,
  ) {}

  private async logPlatformAction(data: {
    platformAdminId: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    businessId?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  }) {
    const metadata: Record<string, unknown> = {
      ...(data.metadata ?? {}),
      ...(data.businessId ? { businessId: data.businessId } : {}),
    };
    let resourceName: string | null = null;
    if (data.resourceId) {
      resourceName = await resolveResourceName(this.prisma, {
        businessId: data.businessId ?? (metadata.businessId as string) ?? '',
        resourceType: data.resourceType,
        resourceId: data.resourceId,
      });
    }
    if (resourceName) {
      metadata.resourceName = resourceName;
    }
    return this.prisma.platformAuditLog.create({
      data: {
        platformAdminId: data.platformAdminId,
        action: data.action,
        resourceType: data.resourceType,
        resourceId: data.resourceId ?? null,
        reason: data.reason ?? null,
        metadata: Object.keys(metadata).length
          ? (metadata as Prisma.InputJsonValue)
          : undefined,
      },
    });
  }

  private async assertBusinessConcurrency(
    businessId: string,
    expectedUpdatedAt?: Date | null,
  ) {
    if (!expectedUpdatedAt) {
      return;
    }
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { updatedAt: true },
    });
    if (!business) {
      throw new BadRequestException('Business not found.');
    }
    if (business.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
      throw new ConflictException(
        'Business changed since last read. Refresh and retry.',
      );
    }
  }

  private async claimMutationIdempotency(
    businessId: string,
    scope: string,
    key?: string,
  ) {
    const claim = await claimIdempotency(this.prisma, businessId, scope, key);
    if (claim?.existing) {
      throw new ConflictException('Duplicate idempotency key.');
    }
    return claim;
  }

  private assertValidBusinessTransition(from: BusinessStatus, to: BusinessStatus) {
    if (from === to) {
      return;
    }
    if (!BUSINESS_STATUS_TRANSITIONS[from].has(to)) {
      throw new BadRequestException(
        `Invalid business status transition: ${from} -> ${to}.`,
      );
    }
  }

  private assertValidIncidentTransition(
    from: PlatformIncidentStatus,
    to: PlatformIncidentStatus,
  ) {
    if (from === to) {
      return;
    }
    if (!INCIDENT_STATUS_TRANSITIONS[from].has(to)) {
      throw new BadRequestException(
        `Invalid incident transition: ${from} -> ${to}.`,
      );
    }
  }

  private percentile(values: number[], percentile: number) {
    if (!values.length) {
      return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1),
    );
    return sorted[rank] ?? 0;
  }

  private async createIncidentEvent(data: {
    incidentId: string;
    eventType: string;
    createdByAdminId?: string;
    note?: string;
    fromStatus?: PlatformIncidentStatus;
    toStatus?: PlatformIncidentStatus;
    metadata?: Record<string, unknown>;
  }) {
    return this.prisma.platformIncidentEvent.create({
      data: {
        incidentId: data.incidentId,
        eventType: data.eventType,
        createdByAdminId: data.createdByAdminId ?? null,
        note: data.note ?? null,
        fromStatus: data.fromStatus ?? null,
        toStatus: data.toStatus ?? null,
        metadata: data.metadata
          ? (data.metadata as Prisma.InputJsonValue)
          : undefined,
      },
    });
  }

  private async syncBusinessReviewFromIncidents(businessId: string) {
    const activeStatuses: PlatformIncidentStatus[] = [
      PlatformIncidentStatus.OPEN,
      PlatformIncidentStatus.INVESTIGATING,
      PlatformIncidentStatus.MITIGATED,
    ];
    const activeIncidents = await this.prisma.platformIncident.findMany({
      where: {
        businessId,
        status: { in: activeStatuses },
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: 1,
    });
    const primary = activeIncidents[0];
    if (!primary) {
      await this.prisma.business.update({
        where: { id: businessId },
        data: {
          underReview: false,
          reviewReason: null,
          reviewSeverity: null,
          reviewedAt: new Date(),
        },
      });
      return;
    }
    await this.prisma.business.update({
      where: { id: businessId },
      data: {
        underReview: true,
        reviewReason: primary.reason,
        reviewSeverity: primary.severity,
        reviewedAt: new Date(),
      },
    });
  }

  async provisionBusiness(data: {
    businessName: string;
    ownerName: string;
    ownerEmail: string;
    ownerTempPassword: string;
    tier?: SubscriptionTier;
  }) {
    const { business, roles } = await this.businessService.createBusiness({
      name: data.businessName,
      tier: data.tier,
    });

    const owner = await this.usersService.create(business.id, {
      name: data.ownerName,
      email: data.ownerEmail,
      status: 'PENDING',
      tempPassword: data.ownerTempPassword,
      mustResetPassword: true,
    });

    const systemOwnerRoleId = roles['System Owner'];
    if (systemOwnerRoleId) {
      await this.usersService.assignRole(owner.id, systemOwnerRoleId);
    }

    const verification = await this.authService.requestEmailVerification(
      owner.id,
      business.id,
    );

    return { business, owner, verificationToken: verification?.token };
  }

  listBusinesses(
    query: PaginationQuery & { status?: string; search?: string } = {},
  ) {
    const pagination = parsePagination(query);
    const search = query.search?.trim();
    return this.prisma.business
      .findMany({
        where: {
          ...(query.status ? { status: query.status as BusinessStatus } : {}),
          ...(search
            ? {
                OR: [
                  {
                    name: {
                      contains: search,
                      mode: Prisma.QueryMode.insensitive,
                    },
                  },
                  {
                    id: {
                      contains: search,
                      mode: Prisma.QueryMode.insensitive,
                    },
                  },
                ],
              }
            : {}),
        },
        include: {
          subscription: true,
          settings: { select: { readOnlyEnabled: true, readOnlyReason: true } },
          _count: {
            select: {
              branches: true,
              businessUsers: true,
              offlineDevices: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        ...pagination,
      })
      .then(async (items) => {
        const businessIds = items.map((business) => business.id);
        const activeOfflineCounts = businessIds.length
          ? await this.prisma.offlineDevice.groupBy({
              by: ['businessId'],
              where: { businessId: { in: businessIds }, status: 'ACTIVE' },
              _count: { _all: true },
            })
          : [];
        const activeCountMap = new Map(
          activeOfflineCounts.map((row) => [row.businessId, row._count._all]),
        );
        const enriched = items.map((business) => {
          const lastActivity = business.lastActivityAt
            ? business.lastActivityAt.toISOString()
            : null;
          return {
            ...business,
            counts: {
              branches: business._count.branches,
              users: business._count.businessUsers,
              offlineDevices: activeCountMap.get(business.id) ?? 0,
            },
            lastActivityAt: lastActivity,
          };
        });
        return buildPaginatedResponse(enriched, pagination.take);
      });
  }

  listAuditLogs(
    businessId: string | undefined,
    query: PaginationQuery & {
      action?: string;
      resourceType?: string;
      outcome?: string;
      resourceId?: string;
      correlationId?: string;
      requestId?: string;
      sessionId?: string;
      deviceId?: string;
    } = {},
  ) {
    const pagination = parsePagination(query, 50, 200);
    return this.prisma.auditLog
      .findMany({
        where: {
          ...(businessId ? { businessId } : {}),
          ...(query.action ? { action: query.action } : {}),
          ...(query.resourceType ? { resourceType: query.resourceType } : {}),
          ...(query.outcome ? { outcome: query.outcome } : {}),
          ...(query.resourceId ? { resourceId: query.resourceId } : {}),
          ...(query.correlationId
            ? { correlationId: query.correlationId }
            : {}),
          ...(query.requestId ? { requestId: query.requestId } : {}),
          ...(query.sessionId ? { sessionId: query.sessionId } : {}),
          ...(query.deviceId ? { deviceId: query.deviceId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        ...pagination,
      })
      .then((items) => buildPaginatedResponse(items, pagination.take));
  }

  listPlatformAuditLogs(
    query: PaginationQuery & {
      action?: string;
      resourceType?: string;
      resourceId?: string;
      platformAdminId?: string;
    } = {},
  ) {
    const pagination = parsePagination(query, 50, 200);
    return this.prisma.platformAuditLog
      .findMany({
        where: {
          ...(query.action ? { action: query.action } : {}),
          ...(query.resourceType ? { resourceType: query.resourceType } : {}),
          ...(query.resourceId ? { resourceId: query.resourceId } : {}),
          ...(query.platformAdminId
            ? { platformAdminId: query.platformAdminId }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        ...pagination,
      })
      .then((items) => buildPaginatedResponse(items, pagination.take));
  }

  private async buildQueuesSummary(): Promise<QueueSummary> {
    const [supportGrouped, exportsGrouped, subscriptionsGrouped] =
      await Promise.all([
        this.prisma.supportAccessRequest.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
        this.prisma.exportJob.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
        this.prisma.subscriptionRequest.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
      ]);

    const toStatusMap = (
      rows: Array<{ status: string; _count: { _all: number } }>,
    ) =>
      rows.reduce<QueueStatusCounts>((acc, row) => {
        acc[row.status] = row._count._all;
        return acc;
      }, {});

    const supportByStatus = toStatusMap(supportGrouped);
    const exportsByStatus = toStatusMap(exportsGrouped);
    const subscriptionsByStatus = toStatusMap(subscriptionsGrouped);

    return {
      support: {
        total: Object.values(supportByStatus).reduce((sum, value) => sum + value, 0),
        byStatus: supportByStatus,
      },
      exports: {
        total: Object.values(exportsByStatus).reduce((sum, value) => sum + value, 0),
        byStatus: exportsByStatus,
      },
      subscriptions: {
        total: Object.values(subscriptionsByStatus).reduce(
          (sum, value) => sum + value,
          0,
        ),
        byStatus: subscriptionsByStatus,
      },
    };
  }

  async getQueuesSummary() {
    return this.buildQueuesSummary();
  }

  async getOverviewSnapshot(params: {
    range: MetricsRange;
    from?: Date | null;
    to?: Date | null;
  }) {
    const [metrics, queues, announcementsActive, recentActions, tierRows, userStatusRows] =
      await Promise.all([
        this.getPlatformMetrics(params.range, params.from, params.to),
        this.buildQueuesSummary(),
        this.prisma.platformAnnouncement.count({
          where: {
            startsAt: { lte: new Date() },
            OR: [{ endsAt: null }, { endsAt: { gte: new Date() } }],
          },
        }),
        this.prisma.platformAuditLog.findMany({
          orderBy: { createdAt: 'desc' },
          take: 12,
        }),
        this.prisma.subscription.groupBy({
          by: ['tier'],
          _count: { _all: true },
        }),
        this.prisma.businessUser.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
      ]);

    const tierCounts = tierRows.reduce<Record<string, number>>((acc, row) => {
      acc[row.tier] = row._count._all;
      return acc;
    }, {});
    const knownTierTotal = Object.values(tierCounts).reduce((sum, value) => sum + value, 0);
    const unknownTierCount = Math.max(0, metrics.totals.businesses - knownTierTotal);

    const userCounts = userStatusRows.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = row._count._all;
      return acc;
    }, {});
    const totalUsers = Object.values(userCounts).reduce((sum, value) => sum + value, 0);
    const activeUsers = userCounts.ACTIVE ?? 0;
    const inactiveUsers = userCounts.INACTIVE ?? 0;
    const pendingUsers = userCounts.PENDING ?? 0;
    const queuePressureTotal =
      queues.support.total + queues.exports.total + queues.subscriptions.total;

    return {
      generatedAt: new Date().toISOString(),
      range: metrics.range,
      kpis: {
        businesses: metrics.totals.businesses,
        activeBusinesses: metrics.totals.active,
        underReview: metrics.totals.underReview,
        offlineEnabled: metrics.totals.offlineEnabled,
        totalStorageMb: metrics.storage.totalMb,
        totalUsers,
        activeUsers,
      },
      anomalies: {
        offlineFailures: metrics.offlineFailures,
        exportsPending: metrics.exports.pending,
        apiErrorRate: metrics.api.errorRate,
        apiAvgLatencyMs: metrics.api.avgLatency,
        activeAnnouncements: announcementsActive,
      },
      distributions: {
        tiers: [
          {
            tier: SubscriptionTier.STARTER,
            count: tierCounts[SubscriptionTier.STARTER] ?? 0,
          },
          {
            tier: SubscriptionTier.BUSINESS,
            count: tierCounts[SubscriptionTier.BUSINESS] ?? 0,
          },
          {
            tier: SubscriptionTier.ENTERPRISE,
            count: tierCounts[SubscriptionTier.ENTERPRISE] ?? 0,
          },
          { tier: 'UNKNOWN', count: unknownTierCount },
        ],
        businessStatuses: [
          { status: 'ACTIVE', count: metrics.totals.active },
          { status: 'GRACE', count: metrics.totals.grace },
          { status: 'EXPIRED', count: metrics.totals.expired },
          { status: 'SUSPENDED', count: metrics.totals.suspended },
          { status: 'UNDER_REVIEW', count: metrics.totals.underReview },
        ],
        users: {
          active: activeUsers,
          inactive: inactiveUsers,
          pending: pendingUsers,
          total: totalUsers,
        },
      },
      signals: {
        queuePressureTotal,
        exportsFailed: queues.exports.byStatus[ExportJobStatus.FAILED] ?? 0,
        apiTotalRequests: metrics.api.totalRequests,
      },
      queues,
      activity: recentActions.map((entry) => ({
        id: entry.id,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        reason: entry.reason,
        metadata: entry.metadata,
        createdAt: entry.createdAt,
      })),
      series: metrics.series,
    };
  }

  async getHealthMatrix() {
    const now = new Date();
    const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const staleDeviceThreshold = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [
      metrics,
      queues,
      offlineFailedCount,
      exportsPendingCount,
      reviewCount,
      offlineFailed7dCount,
      staleActiveDevices,
      revokedDevices,
    ] = await Promise.all([
        this.getPlatformMetrics('24h', null, now),
        this.buildQueuesSummary(),
        this.prisma.offlineAction.count({
          where: { status: 'FAILED', createdAt: { gte: start, lte: now } },
        }),
        this.prisma.exportJob.count({
          where: { status: 'PENDING' },
        }),
        this.prisma.business.count({ where: { underReview: true } }),
        this.prisma.offlineAction.count({
          where: { status: 'FAILED', createdAt: { gte: sevenDaysStart, lte: now } },
        }),
        this.prisma.offlineDevice.count({
          where: {
            status: 'ACTIVE',
            OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: staleDeviceThreshold } }],
          },
        }),
        this.prisma.offlineDevice.count({
          where: { status: 'REVOKED' },
        }),
      ]);

    const dependencyStatus = (
      signal: number,
      warnThreshold: number,
      criticalThreshold: number,
    ) => {
      if (signal >= criticalThreshold) return 'CRITICAL';
      if (signal >= warnThreshold) return 'WARNING';
      return 'HEALTHY';
    };

    const dependencies = [
      {
        key: 'api',
        label: 'Core API',
        status: dependencyStatus(metrics.api.errorRate * 100, 2, 5),
        detail: {
          errorRate: metrics.api.errorRate,
          avgLatencyMs: metrics.api.avgLatency,
          p95LatencyMs: metrics.api.p95Latency,
          p99LatencyMs: metrics.api.p99Latency,
          slowEndpoints: metrics.api.slowEndpoints,
        },
      },
      {
        key: 'offline',
        label: 'Offline Pipeline',
        status: dependencyStatus(offlineFailedCount, 10, 30),
        detail: {
          failedActions24h: offlineFailedCount,
          failedActions7d: offlineFailed7dCount,
          staleActiveDevices,
          revokedDevices,
        },
      },
      {
        key: 'exports',
        label: 'Export Queue',
        status: dependencyStatus(exportsPendingCount, 20, 60),
        detail: { pending: exportsPendingCount },
      },
      {
        key: 'support',
        label: 'Support Queue',
        status: dependencyStatus(queues.support.byStatus.PENDING ?? 0, 10, 25),
        detail: { pending: queues.support.byStatus.PENDING ?? 0 },
      },
      {
        key: 'subscriptions',
        label: 'Subscription Requests',
        status: dependencyStatus(
          queues.subscriptions.byStatus.PENDING ?? 0,
          10,
          25,
        ),
        detail: { pending: queues.subscriptions.byStatus.PENDING ?? 0 },
      },
    ];

    const rollups = dependencies.reduce(
      (acc, item) => {
        if (item.status === 'CRITICAL') acc.critical += 1;
        else if (item.status === 'WARNING') acc.warning += 1;
        else acc.healthy += 1;
        return acc;
      },
      { healthy: 0, warning: 0, critical: 0 },
    );
    const overallStatus =
      rollups.critical > 0
        ? 'CRITICAL'
        : rollups.warning > 0
          ? 'WARNING'
          : 'HEALTHY';

    const totalQueuePending =
      (queues.exports.byStatus.PENDING ?? 0) +
      (queues.support.byStatus.PENDING ?? 0) +
      (queues.subscriptions.byStatus.PENDING ?? 0);
    const queuePressureScore = Math.min(
      100,
      totalQueuePending + (queues.exports.byStatus.FAILED ?? 0) * 2,
    );
    const queuePressureStatus =
      queuePressureScore >= 80
        ? 'CRITICAL'
        : queuePressureScore >= 40
          ? 'WARNING'
          : 'HEALTHY';

    const syncRiskScore = Math.min(
      100,
      offlineFailedCount * 2 + staleActiveDevices * 3 + revokedDevices,
    );
    const syncRiskStatus =
      syncRiskScore >= 80
        ? 'CRITICAL'
        : syncRiskScore >= 40
          ? 'WARNING'
          : 'HEALTHY';

    return {
      generatedAt: now.toISOString(),
      window: { start: start.toISOString(), end: now.toISOString() },
      dependencies,
      rollups: {
        ...rollups,
        overallStatus,
      },
      telemetry: {
        api: {
          totalRequests: metrics.api.totalRequests,
          errorRate: metrics.api.errorRate,
          avgLatencyMs: metrics.api.avgLatency,
          p95LatencyMs: metrics.api.p95Latency,
          p99LatencyMs: metrics.api.p99Latency,
          leaders: metrics.api.slowEndpoints,
        },
        syncRisk: {
          score: syncRiskScore,
          status: syncRiskStatus,
          failedActions24h: offlineFailedCount,
          failedActions7d: offlineFailed7dCount,
          staleActiveDevices,
          revokedDevices,
        },
        queuePressure: {
          score: queuePressureScore,
          status: queuePressureStatus,
          totalPending: totalQueuePending,
          exportsPending: queues.exports.byStatus.PENDING ?? 0,
          supportPending: queues.support.byStatus.PENDING ?? 0,
          subscriptionsPending: queues.subscriptions.byStatus.PENDING ?? 0,
          exportsFailed: queues.exports.byStatus.FAILED ?? 0,
          lanes: queues,
        },
      },
      pressure: {
        underReviewBusinesses: reviewCount,
        queues,
      },
    };
  }

  async getBusinessWorkspace(businessId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      include: {
        subscription: true,
        settings: {
          select: {
            readOnlyEnabled: true,
            readOnlyReason: true,
            rateLimitOverride: true,
          },
        },
        _count: {
          select: {
            branches: true,
            businessUsers: true,
            offlineDevices: true,
          },
        },
      },
    });

    if (!business) {
      throw new BadRequestException('Business not found.');
    }

    const [health, pendingSupport, pendingExports, pendingSubscriptionRequests, devices, auditActions] =
      await Promise.all([
        this.getBusinessHealth(businessId),
        this.prisma.supportAccessRequest.count({
          where: { businessId, status: 'PENDING' },
        }),
        this.prisma.exportJob.count({
          where: { businessId, status: 'PENDING' },
        }),
        this.prisma.subscriptionRequest.count({
          where: { businessId, status: 'PENDING' },
        }),
        this.prisma.offlineDevice.findMany({
          where: { businessId },
          orderBy: { createdAt: 'desc' },
          take: 25,
        }),
        this.prisma.auditLog.findMany({
          where: { businessId },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
      ]);

    const recentAdminActions = auditActions.map((log) => ({
      id: log.id,
      action: log.action,
      outcome: log.outcome,
      resourceType: log.resourceType,
      resourceId: log.resourceId,
      reason: log.reason,
      requestId: log.requestId,
      sessionId: log.sessionId,
      correlationId: log.correlationId,
      createdAt: log.createdAt,
    }));

    return {
      business: {
        id: business.id,
        name: business.name,
        status: business.status,
        underReview: business.underReview,
        reviewReason: business.reviewReason,
        reviewSeverity: business.reviewSeverity,
        createdAt: business.createdAt,
        updatedAt: business.updatedAt,
        lastActivityAt: business.lastActivityAt,
      },
      subscription: business.subscription,
      settings: business.settings,
      counts: {
        branches: business._count.branches,
        users: business._count.businessUsers,
        offlineDevices: business._count.offlineDevices,
      },
      risk: health,
      queues: {
        pendingSupport,
        pendingExports,
        pendingSubscriptionRequests,
      },
      devices,
      recentAdminActions,
      generatedAt: new Date().toISOString(),
    };
  }

  async getAuditTimeline(
    query: PaginationQuery & {
      businessId?: string;
      action?: string;
      resourceType?: string;
      outcome?: string;
      correlationId?: string;
      requestId?: string;
      sessionId?: string;
    } = {},
  ) {
    const pagination = parsePagination(query, 80, 200);
    const logs = await this.prisma.auditLog.findMany({
      where: {
        ...(query.businessId ? { businessId: query.businessId } : {}),
        ...(query.action ? { action: query.action } : {}),
        ...(query.resourceType ? { resourceType: query.resourceType } : {}),
        ...(query.outcome ? { outcome: query.outcome } : {}),
        ...(query.correlationId ? { correlationId: query.correlationId } : {}),
        ...(query.requestId ? { requestId: query.requestId } : {}),
        ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...pagination,
    });

    const groups = new Map<
      string,
      {
        id: string;
        key: string;
        groupType: 'correlation' | 'request' | 'session' | 'entry';
        businessId: string;
        startedAt: Date;
        latestAt: Date;
        count: number;
        outcomes: Record<string, number>;
        actions: Array<{
          id: string;
          action: string;
          outcome: string;
          resourceType: string;
          resourceId: string | null;
          createdAt: Date;
        }>;
      }
    >();

    logs.forEach((log) => {
      const groupType = log.correlationId
        ? 'correlation'
        : log.requestId
          ? 'request'
          : log.sessionId
            ? 'session'
            : 'entry';
      const key =
        log.correlationId ??
        log.requestId ??
        log.sessionId ??
        `entry:${log.id}`;
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          id: key,
          key,
          groupType,
          businessId: log.businessId,
          startedAt: log.createdAt,
          latestAt: log.createdAt,
          count: 1,
          outcomes: { [log.outcome]: 1 },
          actions: [
            {
              id: log.id,
              action: log.action,
              outcome: log.outcome,
              resourceType: log.resourceType,
              resourceId: log.resourceId,
              createdAt: log.createdAt,
            },
          ],
        });
        return;
      }
      existing.count += 1;
      existing.latestAt = existing.latestAt < log.createdAt ? log.createdAt : existing.latestAt;
      existing.startedAt = existing.startedAt > log.createdAt ? log.createdAt : existing.startedAt;
      existing.outcomes[log.outcome] = (existing.outcomes[log.outcome] ?? 0) + 1;
      if (existing.actions.length < 10) {
        existing.actions.push({
          id: log.id,
          action: log.action,
          outcome: log.outcome,
          resourceType: log.resourceType,
          resourceId: log.resourceId,
          createdAt: log.createdAt,
        });
      }
    });

    const groupRows = Array.from(groups.values()).map((group) => ({
      ...group,
      actions: group.actions.sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      ),
    }));

    const allResourceIds = Array.from(
      new Set(
        groupRows.flatMap((group) =>
          group.actions
            .map((action) => action.resourceId)
            .filter((resourceId): resourceId is string => Boolean(resourceId)),
        ),
      ),
    );
    const businessIds = Array.from(
      new Set(groupRows.map((group) => group.businessId).filter(Boolean)),
    );
    const earliest = groupRows.reduce<Date | null>(
      (min, row) => (!min || row.startedAt < min ? row.startedAt : min),
      null,
    );
    const latest = groupRows.reduce<Date | null>(
      (max, row) => (!max || row.latestAt > max ? row.latestAt : max),
      null,
    );
    const from = earliest
      ? new Date(earliest.getTime() - 10 * 60 * 1000)
      : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = latest
      ? new Date(latest.getTime() + 10 * 60 * 1000)
      : new Date();

    const platformWhereOr: Prisma.PlatformAuditLogWhereInput[] = [];
    if (allResourceIds.length) {
      platformWhereOr.push({ resourceId: { in: allResourceIds } });
    }
    businessIds.forEach((businessId) => {
      platformWhereOr.push({
        metadata: {
          path: ['businessId'],
          equals: businessId,
        },
      });
    });
    const platformRows =
      platformWhereOr.length > 0
        ? await this.prisma.platformAuditLog.findMany({
            where: {
              createdAt: { gte: from, lte: to },
              OR: platformWhereOr,
            },
            orderBy: [{ createdAt: 'desc' }],
            take: 500,
          })
        : [];

    const resolveMetadataBusinessId = (metadata: Prisma.JsonValue | null) => {
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return null;
      }
      const value = (metadata as Record<string, unknown>).businessId;
      return typeof value === 'string' && value.trim() ? value : null;
    };

    const items = groupRows.map((group) => {
      const resourceSummary = group.actions.reduce<
        Array<{ resourceType: string; resourceId: string | null; count: number }>
      >((acc, action) => {
        const key = `${action.resourceType}:${action.resourceId ?? 'none'}`;
        const existing = acc.find(
          (entry) =>
            entry.resourceType === action.resourceType &&
            entry.resourceId === (action.resourceId ?? null),
        );
        if (existing) {
          existing.count += 1;
          return acc;
        }
        acc.push({
          resourceType: action.resourceType,
          resourceId: action.resourceId ?? null,
          count: 1,
        });
        return acc;
      }, []);

      const windowStart = new Date(group.startedAt.getTime() - 5 * 60 * 1000);
      const windowEnd = new Date(group.latestAt.getTime() + 5 * 60 * 1000);
      const groupResourceIds = new Set(
        group.actions
          .map((action) => action.resourceId)
          .filter((value): value is string => Boolean(value)),
      );
      const relatedPlatformActions = platformRows
        .filter((entry) => {
          if (entry.createdAt < windowStart || entry.createdAt > windowEnd) {
            return false;
          }
          const metadataBusinessId = resolveMetadataBusinessId(entry.metadata);
          if (metadataBusinessId && metadataBusinessId === group.businessId) {
            return true;
          }
          if (entry.resourceId && groupResourceIds.has(entry.resourceId)) {
            return true;
          }
          return false;
        })
        .slice(0, 10)
        .map((entry) => ({
          id: entry.id,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          reason: entry.reason,
          createdAt: entry.createdAt.toISOString(),
          metadata: entry.metadata,
        }));

      return {
        id: group.id,
        key: group.key,
        groupType: group.groupType,
        businessId: group.businessId,
        startedAt: group.startedAt.toISOString(),
        latestAt: group.latestAt.toISOString(),
        count: group.count,
        outcomes: group.outcomes,
        actions: group.actions.map((action) => ({
          ...action,
          createdAt: action.createdAt.toISOString(),
        })),
        resourceSummary,
        relatedPlatformActions,
      };
    });

    const nextCursor = logs.length >= pagination.take ? logs[logs.length - 1]?.id ?? null : null;

    return {
      items,
      nextCursor,
    };
  }

  async updateBusinessStatus(
    businessId: string,
    status: BusinessStatus,
    platformAdminId: string,
    reason?: string,
    expectedUpdatedAt?: Date | null,
    idempotencyKey?: string,
  ) {
    if (!reason) {
      throw new BadRequestException('Reason is required.');
    }
    await this.assertBusinessConcurrency(businessId, expectedUpdatedAt);
    const idem = await this.claimMutationIdempotency(
      businessId,
      'platform:business-status',
      idempotencyKey,
    );
    const before = await this.prisma.business.findUnique({
      where: { id: businessId },
    });
    if (!before) {
      throw new BadRequestException('Business not found.');
    }
    this.assertValidBusinessTransition(before.status, status);
    const updated = await this.prisma.business.update({
      where: { id: businessId },
      data: { status },
    });
    const archivedStatuses = new Set<BusinessStatus>([
      BusinessStatus.ARCHIVED,
      BusinessStatus.DELETED,
    ]);
    if (archivedStatuses.has(status)) {
      const userIds = await this.prisma.businessUser
        .findMany({
          where: { businessId },
          select: { userId: true },
        })
        .then((rows) => rows.map((row) => row.userId));
      if (userIds.length) {
        await this.prisma.refreshToken.updateMany({
          where: { userId: { in: userIds }, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      await this.logPlatformAction({
        platformAdminId,
        action: 'BUSINESS_FORCE_LOGOUT',
        resourceType: 'Business',
        resourceId: businessId,
        businessId,
        reason: 'Business deleted',
        metadata: { revokedUsers: userIds.length },
      });
    }
    await this.auditService.logEvent({
      businessId,
      userId: platformAdminId,
      action: 'BUSINESS_STATUS_UPDATE',
      resourceType: 'Business',
      resourceId: businessId,
      outcome: 'SUCCESS',
      reason,
      metadata: { status },
      before: before as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });
    await this.logPlatformAction({
      platformAdminId,
      action: 'BUSINESS_STATUS_UPDATE',
      resourceType: 'Business',
      resourceId: businessId,
      businessId,
      reason,
      metadata: { status },
    });
    if (idem) {
      await finalizeIdempotency(this.prisma, idem.record.id, {
        resourceType: 'Business',
        resourceId: businessId,
        metadata: { action: 'BUSINESS_STATUS_UPDATE', status },
      });
    }
    return updated;
  }

  async purgeBusiness(
    businessId: string,
    platformAdminId: string,
    reason?: string,
    confirmBusinessId?: string,
    confirmText?: string,
    dryRun?: boolean,
    expectedUpdatedAt?: Date | null,
    idempotencyKey?: string,
  ) {
    if (!reason) {
      throw new BadRequestException('Reason is required.');
    }
    await this.assertBusinessConcurrency(businessId, expectedUpdatedAt);
    const idem = dryRun
      ? null
      : await this.claimMutationIdempotency(
          businessId,
          'platform:business-purge',
          idempotencyKey,
        );
    if (!dryRun) {
      if (confirmBusinessId !== businessId) {
        throw new BadRequestException(
          'Business ID confirmation does not match.',
        );
      }
      if (confirmText !== 'DELETE') {
        throw new BadRequestException('Confirmation text does not match.');
      }
    }

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });
    if (!business) {
      throw new BadRequestException('Business not found.');
    }
    const archivedStatuses = new Set<BusinessStatus>([
      BusinessStatus.ARCHIVED,
      BusinessStatus.DELETED,
    ]);
    if (!archivedStatuses.has(business.status)) {
      throw new BadRequestException('Business must be archived before purge.');
    }

    const [
      branchIds,
      roleIds,
      saleIds,
      refundIds,
      purchaseIds,
      purchaseOrderIds,
      supplierReturnIds,
      transferIds,
      priceListIds,
      businessUserIds,
    ] = await Promise.all([
      this.prisma.branch.findMany({
        where: { businessId },
        select: { id: true },
      }),
      this.prisma.role.findMany({
        where: { businessId },
        select: { id: true },
      }),
      this.prisma.sale.findMany({
        where: { businessId },
        select: { id: true },
      }),
      this.prisma.saleRefund.findMany({
        where: { businessId },
        select: { id: true },
      }),
      this.prisma.purchase.findMany({
        where: { businessId },
        select: { id: true },
      }),
      this.prisma.purchaseOrder.findMany({
        where: { businessId },
        select: { id: true },
      }),
      this.prisma.supplierReturn.findMany({
        where: { businessId },
        select: { id: true },
      }),
      this.prisma.transfer.findMany({
        where: { businessId },
        select: { id: true },
      }),
      this.prisma.priceList.findMany({
        where: { businessId },
        select: { id: true },
      }),
      this.prisma.businessUser.findMany({
        where: { businessId },
        select: { userId: true },
      }),
    ]);

    const saleIdList = saleIds.map((item) => item.id);
    const refundIdList = refundIds.map((item) => item.id);
    const purchaseIdList = purchaseIds.map((item) => item.id);
    const purchaseOrderIdList = purchaseOrderIds.map((item) => item.id);
    const supplierReturnIdList = supplierReturnIds.map((item) => item.id);
    const transferIdList = transferIds.map((item) => item.id);
    const priceListIdList = priceListIds.map((item) => item.id);
    const roleIdList = roleIds.map((item) => item.id);
    const userIdList = businessUserIds.map((item) => item.userId);

    if (dryRun) {
      const [
        businessUserCount,
        offlineDeviceCount,
        offlineActionCount,
        stockMovementCount,
        stockSnapshotCount,
        notificationCount,
        auditLogCount,
      ] = await Promise.all([
        this.prisma.businessUser.count({ where: { businessId } }),
        this.prisma.offlineDevice.count({ where: { businessId } }),
        this.prisma.offlineAction.count({ where: { businessId } }),
        this.prisma.stockMovement.count({ where: { businessId } }),
        this.prisma.stockSnapshot.count({ where: { businessId } }),
        this.prisma.notification.count({ where: { businessId } }),
        this.prisma.auditLog.count({ where: { businessId } }),
      ]);
      return {
        dryRun: true,
        businessId,
        counts: {
          branches: branchIds.length,
          roles: roleIdList.length,
          sales: saleIdList.length,
          refunds: refundIdList.length,
          purchases: purchaseIdList.length,
          purchaseOrders: purchaseOrderIdList.length,
          supplierReturns: supplierReturnIdList.length,
          transfers: transferIdList.length,
          priceLists: priceListIdList.length,
          businessUsers: businessUserCount,
          offlineDevices: offlineDeviceCount,
          offlineActions: offlineActionCount,
          stockMovements: stockMovementCount,
          stockSnapshots: stockSnapshotCount,
          notifications: notificationCount,
          auditLogs: auditLogCount,
        },
      };
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.noteReminder.deleteMany({ where: { businessId } });
      await tx.noteLink.deleteMany({ where: { businessId } });
      await tx.note.deleteMany({ where: { businessId } });
      await tx.notification.deleteMany({ where: { businessId } });
      await tx.offlineAction.deleteMany({ where: { businessId } });
      await tx.offlineDevice.deleteMany({ where: { businessId } });
      await tx.approval.deleteMany({ where: { businessId } });
      await tx.approvalPolicy.deleteMany({ where: { businessId } });
      await tx.exportJob.deleteMany({ where: { businessId } });
      await tx.apiMetric.deleteMany({ where: { businessId } });
      await tx.subscriptionRequest.deleteMany({ where: { businessId } });
      await tx.subscriptionHistory.deleteMany({ where: { businessId } });
      await tx.subscription.deleteMany({ where: { businessId } });
      await tx.supportAccessSession.deleteMany({ where: { businessId } });
      await tx.supportAccessRequest.deleteMany({ where: { businessId } });
      await tx.attachment.deleteMany({ where: { businessId } });
      await tx.saleSettlement.deleteMany({ where: { businessId } });
      if (refundIdList.length) {
        await tx.saleRefundLine.deleteMany({
          where: { refundId: { in: refundIdList } },
        });
      }
      await tx.saleRefund.deleteMany({ where: { businessId } });
      if (saleIdList.length) {
        await tx.receipt.deleteMany({ where: { saleId: { in: saleIdList } } });
        await tx.salePayment.deleteMany({
          where: { saleId: { in: saleIdList } },
        });
        await tx.saleLine.deleteMany({ where: { saleId: { in: saleIdList } } });
      }
      await tx.sale.deleteMany({ where: { businessId } });
      await tx.shift.deleteMany({ where: { businessId } });
      await tx.purchasePayment.deleteMany({ where: { businessId } });
      if (supplierReturnIdList.length) {
        await tx.supplierReturnLine.deleteMany({
          where: { supplierReturnId: { in: supplierReturnIdList } },
        });
      }
      if (purchaseIdList.length || purchaseOrderIdList.length) {
        await tx.receivingLine.deleteMany({
          where: {
            OR: [
              purchaseIdList.length
                ? { purchaseId: { in: purchaseIdList } }
                : undefined,
              purchaseOrderIdList.length
                ? { purchaseOrderId: { in: purchaseOrderIdList } }
                : undefined,
            ].filter(Boolean) as Prisma.ReceivingLineWhereInput[],
          },
        });
      }
      if (purchaseIdList.length) {
        await tx.purchaseLine.deleteMany({
          where: { purchaseId: { in: purchaseIdList } },
        });
      }
      if (purchaseOrderIdList.length) {
        await tx.purchaseOrderLine.deleteMany({
          where: { purchaseOrderId: { in: purchaseOrderIdList } },
        });
      }
      await tx.supplierReturn.deleteMany({ where: { businessId } });
      await tx.purchase.deleteMany({ where: { businessId } });
      await tx.purchaseOrder.deleteMany({ where: { businessId } });
      if (transferIdList.length) {
        await tx.transferItem.deleteMany({
          where: { transferId: { in: transferIdList } },
        });
      }
      await tx.expense.deleteMany({ where: { businessId } });
      await tx.transfer.deleteMany({ where: { businessId } });
      await tx.lossEntry.deleteMany({ where: { businessId } });
      await tx.stockMovement.deleteMany({ where: { businessId } });
      await tx.stockSnapshot.deleteMany({ where: { businessId } });
      await tx.batch.deleteMany({ where: { businessId } });
      await tx.branchVariantAvailability.deleteMany({ where: { businessId } });
      await tx.reorderPoint.deleteMany({ where: { businessId } });
      await tx.barcode.deleteMany({ where: { businessId } });
      await tx.productImage.deleteMany({ where: { businessId } });
      if (priceListIdList.length) {
        await tx.priceListItem.deleteMany({
          where: { priceListId: { in: priceListIdList } },
        });
      }
      await tx.variant.deleteMany({ where: { businessId } });
      await tx.product.deleteMany({ where: { businessId } });
      await tx.category.deleteMany({ where: { businessId } });
      await tx.customer.deleteMany({ where: { businessId } });
      await tx.unit.deleteMany({ where: { businessId } });
      if (roleIdList.length) {
        await tx.userRole.deleteMany({ where: { roleId: { in: roleIdList } } });
        await tx.rolePermission.deleteMany({
          where: { roleId: { in: roleIdList } },
        });
      }
      await tx.role.deleteMany({ where: { businessId } });
      await tx.businessUser.deleteMany({ where: { businessId } });
      await tx.invitation.deleteMany({ where: { businessId } });
      await tx.auditLog.deleteMany({ where: { businessId } });
      await tx.idempotencyKey.deleteMany({ where: { businessId } });
      await tx.businessSettings.deleteMany({ where: { businessId } });
      await tx.branch.deleteMany({ where: { businessId } });
      await tx.priceList.deleteMany({ where: { businessId } });
      await tx.business.delete({ where: { id: businessId } });
    });

    if (userIdList.length) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: { in: userIdList }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await this.logPlatformAction({
      platformAdminId,
      action: 'BUSINESS_PURGE',
      resourceType: 'Business',
      resourceId: businessId,
      businessId,
      reason,
      metadata: {
        name: business.name,
        status: business.status,
      },
    });

    if (idem) {
      await finalizeIdempotency(this.prisma, idem.record.id, {
        resourceType: 'Business',
        resourceId: businessId,
        metadata: { action: 'BUSINESS_PURGE' },
      });
    }

    return { deleted: true };
  }

  async updateSubscription(
    businessId: string,
    data: {
      platformAdminId: string;
      tier?: SubscriptionTier;
      status?: SubscriptionStatus;
      limits?: Record<string, number | string | boolean | null> | null;
      trialEndsAt?: Date | null;
      graceEndsAt?: Date | null;
      expiresAt?: Date | null;
      reason?: string;
      expectedUpdatedAt?: Date | null;
      idempotencyKey?: string;
    },
  ) {
    if (!data.reason) {
      throw new BadRequestException('Reason is required.');
    }
    await this.assertBusinessConcurrency(businessId, data.expectedUpdatedAt);
    const idem = await this.claimMutationIdempotency(
      businessId,
      'platform:subscription-update',
      data.idempotencyKey,
    );
    const existing = await this.prisma.subscription.findUnique({
      where: { businessId },
    });
    const now = new Date();
    const tierForDefaults =
      data.tier ?? existing?.tier ?? SubscriptionTier.BUSINESS;
    const defaultTrialDays = parseInt(
      this.configService.get<string>('subscription.trialDays') ?? '14',
      10,
    );
    const defaultEnterpriseTrialDays = parseInt(
      this.configService.get<string>('subscription.enterpriseTrialDays') ?? '7',
      10,
    );
    const graceDays = parseInt(
      this.configService.get<string>('subscription.graceDays') ?? '7',
      10,
    );
    const trialDays =
      tierForDefaults === SubscriptionTier.ENTERPRISE
        ? defaultEnterpriseTrialDays
        : defaultTrialDays;
    const shouldAutoTrial =
      data.status === SubscriptionStatus.TRIAL && data.trialEndsAt === null;
    const shouldAutoGrace =
      data.status === SubscriptionStatus.GRACE && data.graceEndsAt === null;
    const autoTrialEndsAt = shouldAutoTrial
      ? new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000)
      : undefined;
    const autoGraceEndsAt = shouldAutoGrace
      ? new Date(now.getTime() + graceDays * 24 * 60 * 60 * 1000)
      : undefined;
    const tierChanging =
      data.tier && existing?.tier && data.tier !== existing.tier;
    const updateLimits =
      data.limits !== undefined ? data.limits : tierChanging ? null : undefined;
    const limitsPayload =
      updateLimits === undefined
        ? undefined
        : updateLimits === null
          ? Prisma.DbNull
          : (updateLimits as Prisma.InputJsonValue);
    const subscription = this.prisma.subscription.upsert({
      where: { businessId },
      create: {
        businessId,
        tier: data.tier ?? SubscriptionTier.BUSINESS,
        status: data.status ?? SubscriptionStatus.TRIAL,
        limits:
          data.limits === undefined
            ? Prisma.DbNull
            : (data.limits as Prisma.InputJsonValue),
        trialEndsAt: autoTrialEndsAt ?? data.trialEndsAt ?? null,
        graceEndsAt: autoGraceEndsAt ?? data.graceEndsAt ?? null,
        expiresAt: data.expiresAt ?? null,
      },
      update: {
        tier: data.tier,
        status: data.status,
        limits: limitsPayload,
        trialEndsAt:
          autoTrialEndsAt !== undefined ? autoTrialEndsAt : data.trialEndsAt,
        graceEndsAt:
          autoGraceEndsAt !== undefined ? autoGraceEndsAt : data.graceEndsAt,
        expiresAt: data.expiresAt,
      },
    });
    return Promise.all([existing, subscription]).then(async ([before, after]) => {
      const sideEffects: Promise<unknown>[] = [];

      if (
        data.status &&
        (data.status === SubscriptionStatus.ACTIVE ||
          data.status === SubscriptionStatus.TRIAL)
      ) {
        sideEffects.push(
          this.prisma.businessSettings.updateMany({
            where: { businessId, readOnlyEnabled: true },
            data: {
              readOnlyEnabled: false,
              readOnlyReason: null,
              readOnlyEnabledAt: null,
            },
          }),
        );
      }

      if (after.status === SubscriptionStatus.EXPIRED) {
        sideEffects.push(
          this.prisma.offlineDevice.updateMany({
            where: { businessId, status: 'ACTIVE' },
            data: { status: 'REVOKED', revokedAt: new Date() },
          }),
        );
      }

      const businessStatusMap: Partial<Record<SubscriptionStatus, BusinessStatus>> =
        {
          [SubscriptionStatus.TRIAL]: BusinessStatus.TRIAL,
          [SubscriptionStatus.ACTIVE]: BusinessStatus.ACTIVE,
          [SubscriptionStatus.GRACE]: BusinessStatus.GRACE,
          [SubscriptionStatus.EXPIRED]: BusinessStatus.EXPIRED,
        };
      const mappedBusinessStatus = data.status
        ? businessStatusMap[data.status]
        : undefined;
      if (mappedBusinessStatus) {
        sideEffects.push(
          this.prisma.business.updateMany({
            where: { id: businessId, status: { not: mappedBusinessStatus } },
            data: { status: mappedBusinessStatus },
          }),
        );
      }

      sideEffects.push(
        this.prisma.subscriptionHistory.create({
          data: {
            businessId,
            previousStatus: before?.status ?? null,
            newStatus: after.status,
            previousTier: before?.tier ?? null,
            newTier: after.tier,
            changedByPlatformAdminId: data.platformAdminId,
            reason: data.reason ?? null,
            metadata: limitsPayload,
          },
        }),
      );

      sideEffects.push(
        this.auditService.logEvent({
          businessId,
          userId: data.platformAdminId,
          action: 'SUBSCRIPTION_UPDATE',
          resourceType: 'Subscription',
          outcome: 'SUCCESS',
          reason: data.reason ?? undefined,
          metadata: {
            ...data,
            previousStatus: before?.status ?? null,
            previousTier: before?.tier ?? null,
          },
          before: before as unknown as Record<string, unknown>,
          after: after as unknown as Record<string, unknown>,
        }),
      );

      sideEffects.push(
        this.logPlatformAction({
          platformAdminId: data.platformAdminId,
          action: 'SUBSCRIPTION_UPDATE',
          resourceType: 'Subscription',
          resourceId: after.id,
          businessId,
          reason: data.reason ?? undefined,
          metadata: {
            status: after.status,
            tier: after.tier,
            previousStatus: before?.status ?? null,
            previousTier: before?.tier ?? null,
          },
        }),
      );

      if (
        data.status === SubscriptionStatus.GRACE &&
        before?.status !== SubscriptionStatus.GRACE
      ) {
        const graceEndsAt = data.graceEndsAt ?? before?.graceEndsAt ?? null;
        sideEffects.push(
          this.notificationsService.notifyEvent({
            businessId,
            eventKey: 'graceWarnings',
            title: 'Subscription in grace period',
            message: graceEndsAt
              ? `Your subscription is in grace period until ${graceEndsAt.toDateString()}.`
              : 'Your subscription is in grace period. Please update billing.',
            priority: 'WARNING',
            metadata: {
              graceEndsAt: graceEndsAt?.toISOString() ?? null,
            },
          }),
        );
      }

      await Promise.all(sideEffects);

      if (idem) {
        await finalizeIdempotency(this.prisma, idem.record.id, {
          resourceType: 'Subscription',
          resourceId: after.id,
          metadata: {
            action: 'SUBSCRIPTION_UPDATE',
            status: after.status,
            tier: after.tier,
          },
        });
      }

      return after;
    });
  }

  async recordSubscriptionPurchase(data: {
    businessId: string;
    platformAdminId: string;
    tier: SubscriptionTier;
    durationDays: number;
    startsAt?: Date | null;
    reason?: string;
    expectedUpdatedAt?: Date | null;
    idempotencyKey?: string;
  }) {
    if (!data.reason?.trim()) {
      throw new BadRequestException('Reason is required.');
    }
    const durationDays = Number(data.durationDays);
    if (!Number.isFinite(durationDays) || durationDays <= 0) {
      throw new BadRequestException('Duration days must be greater than zero.');
    }
    const baseStart = data.startsAt ?? new Date();
    if (Number.isNaN(baseStart.getTime())) {
      throw new BadRequestException('Invalid start date.');
    }

    const business = await this.prisma.business.findUnique({
      where: { id: data.businessId },
      select: { id: true, status: true },
    });
    if (!business) {
      throw new BadRequestException('Business not found.');
    }

    if (business.status !== BusinessStatus.ACTIVE) {
      this.assertValidBusinessTransition(business.status, BusinessStatus.ACTIVE);
      await this.updateBusinessStatus(
        data.businessId,
        BusinessStatus.ACTIVE,
        data.platformAdminId,
        data.reason,
        data.expectedUpdatedAt ?? null,
        data.idempotencyKey,
      );
    }

    const graceDays = parseInt(
      this.configService.get<string>('subscription.graceDays') ?? '7',
      10,
    );
    const expiresAt = new Date(
      baseStart.getTime() + durationDays * 24 * 60 * 60 * 1000,
    );
    const graceEndsAt =
      graceDays > 0
        ? new Date(expiresAt.getTime() + graceDays * 24 * 60 * 60 * 1000)
        : null;

    const subscription = await this.updateSubscription(data.businessId, {
      platformAdminId: data.platformAdminId,
      tier: data.tier,
      status: SubscriptionStatus.ACTIVE,
      trialEndsAt: null,
      graceEndsAt,
      expiresAt,
      reason: data.reason,
      expectedUpdatedAt: data.expectedUpdatedAt ?? null,
      idempotencyKey: data.idempotencyKey,
    });

    return {
      subscription,
      lifecycle: {
        startsAt: baseStart.toISOString(),
        expiresAt: expiresAt.toISOString(),
        graceEndsAt: graceEndsAt?.toISOString() ?? null,
        durationDays,
        tier: data.tier,
      },
    };
  }

  async requestExportOnExit(data: {
    businessId: string;
    platformAdminId: string;
    reason?: string;
  }) {
    const job = await this.prisma.exportJob.create({
      data: {
        businessId: data.businessId,
        type: 'EXPORT_ON_EXIT',
        status: 'PENDING',
        requestedByPlatformAdminId: data.platformAdminId,
        metadata: { reason: data.reason ?? null },
      },
    });
    this.auditService.logEvent({
      businessId: data.businessId,
      userId: data.platformAdminId,
      action: 'EXPORT_ON_EXIT_REQUEST',
      resourceType: 'ExportJob',
      resourceId: job.id,
      outcome: 'SUCCESS',
      reason: data.reason ?? undefined,
      metadata: {
        resourceName: 'Export on exit',
        reason: data.reason ?? null,
      },
    });
    this.logPlatformAction({
      platformAdminId: data.platformAdminId,
      action: 'EXPORT_ON_EXIT_REQUEST',
      resourceType: 'ExportJob',
      resourceId: job.id,
      businessId: data.businessId,
      reason: data.reason ?? undefined,
      metadata: { businessId: data.businessId },
    });
    return job;
  }

  async updateReadOnly(
    businessId: string,
    data: {
      enabled: boolean;
      reason?: string | null;
      platformAdminId: string;
      expectedUpdatedAt?: Date | null;
      idempotencyKey?: string;
    },
  ) {
    if (data.enabled && !data.reason) {
      throw new BadRequestException('Reason is required.');
    }
    await this.assertBusinessConcurrency(businessId, data.expectedUpdatedAt);
    const idem = await this.claimMutationIdempotency(
      businessId,
      'platform:readonly-update',
      data.idempotencyKey,
    );
    const existing = await this.prisma.businessSettings.findUnique({
      where: { businessId },
    });
    const nextReason = data.enabled
      ? (data.reason ?? existing?.readOnlyReason ?? null)
      : null;
    const updated = await this.prisma.businessSettings.upsert({
      where: { businessId },
      create: {
        businessId,
        approvalDefaults: DEFAULT_APPROVAL_DEFAULTS,
        notificationDefaults: DEFAULT_NOTIFICATION_SETTINGS,
        stockPolicies: DEFAULT_STOCK_POLICIES,
        posPolicies: DEFAULT_POS_POLICIES,
        localeSettings: DEFAULT_LOCALE_SETTINGS,
        readOnlyEnabled: data.enabled,
        readOnlyReason: nextReason,
        readOnlyEnabledAt: data.enabled ? new Date() : null,
      },
      update: {
        readOnlyEnabled: data.enabled,
        readOnlyReason: nextReason,
        readOnlyEnabledAt: data.enabled ? new Date() : null,
      },
    });
    await this.auditService.logEvent({
      businessId,
      userId: data.platformAdminId,
      action: 'READ_ONLY_UPDATE',
      resourceType: 'BusinessSettings',
      resourceId: updated.id,
      outcome: 'SUCCESS',
      reason: nextReason ?? undefined,
      metadata: {
        enabled: data.enabled,
        reason: nextReason,
      },
      before: existing as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });
    await this.logPlatformAction({
      platformAdminId: data.platformAdminId,
      action: 'READ_ONLY_UPDATE',
      resourceType: 'BusinessSettings',
      resourceId: updated.id,
      businessId,
      reason: nextReason ?? undefined,
      metadata: { businessId, enabled: data.enabled },
    });
    if (idem) {
      await finalizeIdempotency(this.prisma, idem.record.id, {
        resourceType: 'BusinessSettings',
        resourceId: updated.id,
        metadata: { action: 'READ_ONLY_UPDATE', enabled: data.enabled },
      });
    }
    return updated;
  }

  async listSubscriptionRequests(
    query: PaginationQuery & { status?: string } = {},
  ) {
    const pagination = parsePagination(query);
    return this.prisma.subscriptionRequest
      .findMany({
        where: {
          ...(query.status
            ? { status: query.status as SubscriptionRequestStatus }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        ...pagination,
      })
      .then((items) => buildPaginatedResponse(items, pagination.take));
  }

  async listExportJobs(
    query: PaginationQuery & {
      businessId?: string;
      status?: string;
      type?: string;
    } = {},
  ) {
    const pagination = parsePagination(query);
    return this.prisma.exportJob
      .findMany({
        where: {
          ...(query.businessId ? { businessId: query.businessId } : {}),
          ...(query.status ? { status: query.status as ExportJobStatus } : {}),
          ...(query.type ? { type: query.type as ExportJobType } : {}),
        },
        include: {
          business: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        ...pagination,
      })
      .then((items) => buildPaginatedResponse(items, pagination.take));
  }

  async getExportQueueStats(query: {
    businessId?: string;
    type?: string;
  } = {}) {
    const where: Prisma.ExportJobWhereInput = {
      ...(query.businessId ? { businessId: query.businessId } : {}),
      ...(query.type ? { type: query.type as ExportJobType } : {}),
    };
    const [byStatusRows, byTypeRows] = await Promise.all([
      this.prisma.exportJob.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      this.prisma.exportJob.groupBy({
        by: ['type', 'status'],
        where,
        _count: { _all: true },
      }),
    ]);
    const byStatus = byStatusRows.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = row._count._all;
      return acc;
    }, {});
    const byType = byTypeRows.reduce<
      Record<string, { total: number; byStatus: Record<string, number> }>
    >((acc, row) => {
      if (!acc[row.type]) {
        acc[row.type] = { total: 0, byStatus: {} };
      }
      acc[row.type].total += row._count._all;
      acc[row.type].byStatus[row.status] = row._count._all;
      return acc;
    }, {});
    const total = Object.values(byStatus).reduce((sum, value) => sum + value, 0);
    return {
      total,
      byStatus,
      byType,
    };
  }

  async cancelExportJob(data: {
    exportJobId: string;
    platformAdminId: string;
    reason?: string;
  }) {
    const existing = await this.prisma.exportJob.findUnique({
      where: { id: data.exportJobId },
    });
    if (!existing) {
      throw new BadRequestException('Export job not found.');
    }
    if (existing.status !== ExportJobStatus.PENDING) {
      throw new BadRequestException(
        'Only PENDING export jobs can be canceled.',
      );
    }
    const now = new Date();
    const updated = await this.prisma.exportJob.update({
      where: { id: data.exportJobId },
      data: {
        status: ExportJobStatus.CANCELED,
        completedAt: now,
        lastError: null,
      },
    });
    await this.auditService.logEvent({
      businessId: existing.businessId,
      userId: data.platformAdminId,
      action: 'EXPORT_CANCEL',
      resourceType: 'ExportJob',
      resourceId: existing.id,
      outcome: 'SUCCESS',
      reason: data.reason ?? undefined,
      metadata: {
        fromStatus: existing.status,
        toStatus: updated.status,
      },
      before: existing as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });
    await this.logPlatformAction({
      platformAdminId: data.platformAdminId,
      action: 'EXPORT_CANCEL',
      resourceType: 'ExportJob',
      resourceId: existing.id,
      businessId: existing.businessId,
      reason: data.reason ?? undefined,
      metadata: { businessId: existing.businessId },
    });
    return updated;
  }

  async retryExportJob(data: {
    exportJobId: string;
    platformAdminId: string;
    reason?: string;
  }) {
    const existing = await this.prisma.exportJob.findUnique({
      where: { id: data.exportJobId },
    });
    if (!existing) {
      throw new BadRequestException('Export job not found.');
    }
    if (existing.status !== ExportJobStatus.FAILED) {
      throw new BadRequestException('Only FAILED export jobs can be retried.');
    }
    const updated = await this.prisma.exportJob.update({
      where: { id: data.exportJobId },
      data: {
        status: ExportJobStatus.PENDING,
        attempts: 0,
        startedAt: null,
        completedAt: null,
        lastError: null,
        deliveredAt: null,
        deliveredByPlatformAdminId: null,
      },
    });
    await this.auditService.logEvent({
      businessId: existing.businessId,
      userId: data.platformAdminId,
      action: 'EXPORT_RETRY',
      resourceType: 'ExportJob',
      resourceId: existing.id,
      outcome: 'SUCCESS',
      reason: data.reason ?? undefined,
      metadata: {
        fromStatus: existing.status,
        toStatus: updated.status,
      },
      before: existing as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });
    await this.logPlatformAction({
      platformAdminId: data.platformAdminId,
      action: 'EXPORT_RETRY',
      resourceType: 'ExportJob',
      resourceId: existing.id,
      businessId: existing.businessId,
      reason: data.reason ?? undefined,
      metadata: { businessId: existing.businessId },
    });
    return updated;
  }

  async requeueExportJob(data: {
    exportJobId: string;
    platformAdminId: string;
    reason?: string;
  }) {
    const existing = await this.prisma.exportJob.findUnique({
      where: { id: data.exportJobId },
    });
    if (!existing) {
      throw new BadRequestException('Export job not found.');
    }
    if (existing.status === ExportJobStatus.RUNNING) {
      throw new BadRequestException('RUNNING export jobs cannot be requeued.');
    }
    const updated = await this.prisma.exportJob.update({
      where: { id: data.exportJobId },
      data: {
        status: ExportJobStatus.PENDING,
        attempts: 0,
        startedAt: null,
        completedAt: null,
        lastError: null,
        deliveredAt: null,
        deliveredByPlatformAdminId: null,
      },
    });
    await this.auditService.logEvent({
      businessId: existing.businessId,
      userId: data.platformAdminId,
      action: 'EXPORT_REQUEUE',
      resourceType: 'ExportJob',
      resourceId: existing.id,
      outcome: 'SUCCESS',
      reason: data.reason ?? undefined,
      metadata: {
        fromStatus: existing.status,
        toStatus: updated.status,
      },
      before: existing as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });
    await this.logPlatformAction({
      platformAdminId: data.platformAdminId,
      action: 'EXPORT_REQUEUE',
      resourceType: 'ExportJob',
      resourceId: existing.id,
      businessId: existing.businessId,
      reason: data.reason ?? undefined,
      metadata: { businessId: existing.businessId },
    });
    return updated;
  }

  async approveSubscriptionRequest(data: {
    requestId: string;
    platformAdminId: string;
    responseNote?: string;
  }) {
    const request = await this.prisma.subscriptionRequest.findFirst({
      where: { id: data.requestId },
    });
    if (!request) {
      throw new BadRequestException('Subscription request not found.');
    }
    if (request.status !== SubscriptionRequestStatus.PENDING) {
      throw new BadRequestException('Subscription request already resolved.');
    }

    const reason = data.responseNote ?? 'Subscription request approved.';
    if (request.type === SubscriptionRequestType.CANCEL) {
      await this.updateSubscription(request.businessId, {
        platformAdminId: data.platformAdminId,
        status: SubscriptionStatus.EXPIRED,
        expiresAt: new Date(),
        reason,
      });
    } else {
      await this.updateSubscription(request.businessId, {
        platformAdminId: data.platformAdminId,
        tier: request.requestedTier ?? SubscriptionTier.BUSINESS,
        status: SubscriptionStatus.ACTIVE,
        reason,
      });
    }

    const updated = await this.prisma.subscriptionRequest.update({
      where: { id: request.id },
      data: {
        status: SubscriptionRequestStatus.APPROVED,
        decidedAt: new Date(),
        decidedByPlatformAdminId: data.platformAdminId,
        responseNote: data.responseNote ?? null,
      },
    });

    await this.auditService.logEvent({
      businessId: request.businessId,
      userId: data.platformAdminId,
      action: 'SUBSCRIPTION_REQUEST_APPROVE',
      resourceType: 'SubscriptionRequest',
      resourceId: request.id,
      outcome: 'SUCCESS',
      reason,
      metadata: {
        type: request.type,
        requestedTier: request.requestedTier ?? null,
      },
    });
    await this.logPlatformAction({
      platformAdminId: data.platformAdminId,
      action: 'SUBSCRIPTION_REQUEST_APPROVE',
      resourceType: 'SubscriptionRequest',
      resourceId: request.id,
      businessId: request.businessId,
      reason,
      metadata: { businessId: request.businessId },
    });
    await this.notificationsService.notifyEvent({
      businessId: request.businessId,
      eventKey: 'subscriptionRequestApproved',
      title: 'Subscription request approved',
      message:
        request.type === SubscriptionRequestType.CANCEL
          ? 'Your cancellation request was approved.'
          : `Your subscription request was approved (${request.requestedTier ?? ''}).`,
      priority: 'ACTION_REQUIRED',
      metadata: { requestId: request.id, type: request.type },
    });

    return updated;
  }

  async rejectSubscriptionRequest(data: {
    requestId: string;
    platformAdminId: string;
    responseNote?: string;
  }) {
    const request = await this.prisma.subscriptionRequest.findFirst({
      where: { id: data.requestId },
    });
    if (!request) {
      throw new BadRequestException('Subscription request not found.');
    }
    if (request.status !== SubscriptionRequestStatus.PENDING) {
      throw new BadRequestException('Subscription request already resolved.');
    }
    const reason = data.responseNote ?? 'Subscription request rejected.';
    const updated = await this.prisma.subscriptionRequest.update({
      where: { id: request.id },
      data: {
        status: SubscriptionRequestStatus.REJECTED,
        decidedAt: new Date(),
        decidedByPlatformAdminId: data.platformAdminId,
        responseNote: data.responseNote ?? null,
      },
    });

    await this.auditService.logEvent({
      businessId: request.businessId,
      userId: data.platformAdminId,
      action: 'SUBSCRIPTION_REQUEST_REJECT',
      resourceType: 'SubscriptionRequest',
      resourceId: request.id,
      outcome: 'SUCCESS',
      reason,
      metadata: {
        type: request.type,
        requestedTier: request.requestedTier ?? null,
      },
    });
    await this.logPlatformAction({
      platformAdminId: data.platformAdminId,
      action: 'SUBSCRIPTION_REQUEST_REJECT',
      resourceType: 'SubscriptionRequest',
      resourceId: request.id,
      businessId: request.businessId,
      reason,
      metadata: { businessId: request.businessId },
    });
    await this.notificationsService.notifyEvent({
      businessId: request.businessId,
      eventKey: 'subscriptionRequestRejected',
      title: 'Subscription request rejected',
      message: reason,
      priority: 'WARNING',
      metadata: { requestId: request.id, type: request.type },
    });

    return updated;
  }

  async markExportDelivered(data: {
    exportJobId: string;
    platformAdminId: string;
    deliveredAt?: Date;
    reason?: string;
  }) {
    const existing = await this.prisma.exportJob.findUnique({
      where: { id: data.exportJobId },
    });
    if (!existing) {
      throw new BadRequestException('Export job not found.');
    }
    const deliveredAt = data.deliveredAt ?? new Date();
    const updated = await this.prisma.exportJob.update({
      where: { id: data.exportJobId },
      data: {
        deliveredAt,
        deliveredByPlatformAdminId: data.platformAdminId,
      },
    });
    await this.auditService.logEvent({
      businessId: existing.businessId,
      userId: data.platformAdminId,
      action: 'EXPORT_DELIVERED',
      resourceType: 'ExportJob',
      resourceId: existing.id,
      outcome: 'SUCCESS',
      reason: data.reason ?? undefined,
      metadata: { deliveredAt: deliveredAt.toISOString() },
      before: existing as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });
    await this.logPlatformAction({
      platformAdminId: data.platformAdminId,
      action: 'EXPORT_DELIVERED',
      resourceType: 'ExportJob',
      resourceId: existing.id,
      businessId: existing.businessId,
      reason: data.reason ?? undefined,
      metadata: { businessId: existing.businessId },
    });
    return updated;
  }

  async listIncidents(
    query: PaginationQuery & {
      businessId?: string;
      status?: string;
      severity?: string;
    } = {},
  ) {
    const pagination = parsePagination(query, 50, 200);
    return this.prisma.platformIncident
      .findMany({
        where: {
          ...(query.businessId ? { businessId: query.businessId } : {}),
          ...(query.status
            ? { status: query.status as PlatformIncidentStatus }
            : {}),
          ...(query.severity
            ? { severity: query.severity as PlatformIncidentSeverity }
            : {}),
        },
        include: {
          business: { select: { name: true } },
          events: {
            orderBy: { createdAt: 'desc' },
            take: 5,
          },
        },
        orderBy: { createdAt: 'desc' },
        ...pagination,
      })
      .then((items) => buildPaginatedResponse(items, pagination.take));
  }

  async createIncident(data: {
    businessId: string;
    reason: string;
    title?: string;
    severity?: PlatformIncidentSeverity;
    ownerPlatformAdminId?: string;
    metadata?: Record<string, unknown>;
    platformAdminId: string;
  }) {
    if (!data.reason?.trim()) {
      throw new BadRequestException('Reason is required.');
    }
    const incident = await this.prisma.platformIncident.create({
      data: {
        businessId: data.businessId,
        reason: data.reason,
        title: data.title ?? null,
        severity: data.severity ?? PlatformIncidentSeverity.MEDIUM,
        status: PlatformIncidentStatus.OPEN,
        source: 'MANUAL',
        ownerPlatformAdminId: data.ownerPlatformAdminId ?? null,
        createdByPlatformAdminId: data.platformAdminId,
        metadata: data.metadata
          ? (data.metadata as Prisma.InputJsonValue)
          : undefined,
      },
    });
    await this.createIncidentEvent({
      incidentId: incident.id,
      eventType: 'CREATED',
      createdByAdminId: data.platformAdminId,
      note: data.reason,
      toStatus: PlatformIncidentStatus.OPEN,
      metadata: { source: 'MANUAL' },
    });
    await this.syncBusinessReviewFromIncidents(data.businessId);
    await this.logPlatformAction({
      platformAdminId: data.platformAdminId,
      action: 'PLATFORM_INCIDENT_CREATE',
      resourceType: 'PlatformIncident',
      resourceId: incident.id,
      businessId: data.businessId,
      reason: data.reason,
      metadata: {
        severity: incident.severity,
        status: incident.status,
      },
    });
    return incident;
  }

  async updateIncident(data: {
    incidentId: string;
    platformAdminId: string;
    title?: string;
    reason?: string;
    severity?: PlatformIncidentSeverity;
    ownerPlatformAdminId?: string | null;
    status?: PlatformIncidentStatus;
  }) {
    const existing = await this.prisma.platformIncident.findUnique({
      where: { id: data.incidentId },
    });
    if (!existing) {
      throw new BadRequestException('Incident not found.');
    }
    if (data.status && data.status !== existing.status) {
      this.assertValidIncidentTransition(existing.status, data.status);
    }
    const nextStatus = data.status ?? existing.status;
    const updated = await this.prisma.platformIncident.update({
      where: { id: data.incidentId },
      data: {
        title: data.title,
        reason: data.reason,
        severity: data.severity,
        ownerPlatformAdminId: data.ownerPlatformAdminId,
        status: data.status,
        closedAt:
          nextStatus === PlatformIncidentStatus.CLOSED
            ? new Date()
            : nextStatus === PlatformIncidentStatus.RESOLVED
              ? existing.closedAt
              : null,
      },
    });

    await this.createIncidentEvent({
      incidentId: existing.id,
      eventType: 'UPDATED',
      createdByAdminId: data.platformAdminId,
      fromStatus: existing.status,
      toStatus: nextStatus,
      metadata: {
        title: data.title,
        reason: data.reason,
        severity: data.severity,
        ownerPlatformAdminId: data.ownerPlatformAdminId,
      },
    });
    await this.syncBusinessReviewFromIncidents(existing.businessId);
    await this.logPlatformAction({
      platformAdminId: data.platformAdminId,
      action: 'PLATFORM_INCIDENT_UPDATE',
      resourceType: 'PlatformIncident',
      resourceId: existing.id,
      businessId: existing.businessId,
      reason: data.reason ?? undefined,
      metadata: {
        fromStatus: existing.status,
        toStatus: nextStatus,
        severity: updated.severity,
      },
    });
    return updated;
  }

  async transitionIncident(data: {
    incidentId: string;
    platformAdminId: string;
    toStatus: PlatformIncidentStatus;
    reason: string;
    note?: string;
  }) {
    if (!data.reason?.trim()) {
      throw new BadRequestException('Reason is required.');
    }
    const incident = await this.prisma.platformIncident.findUnique({
      where: { id: data.incidentId },
    });
    if (!incident) {
      throw new BadRequestException('Incident not found.');
    }
    this.assertValidIncidentTransition(incident.status, data.toStatus);
    const updated = await this.prisma.platformIncident.update({
      where: { id: incident.id },
      data: {
        status: data.toStatus,
        closedAt:
          data.toStatus === PlatformIncidentStatus.CLOSED ? new Date() : null,
        reason: data.reason,
      },
    });
    await this.createIncidentEvent({
      incidentId: incident.id,
      eventType: 'TRANSITION',
      createdByAdminId: data.platformAdminId,
      note: data.note ?? data.reason,
      fromStatus: incident.status,
      toStatus: data.toStatus,
      metadata: { reason: data.reason },
    });
    await this.syncBusinessReviewFromIncidents(incident.businessId);
    await this.logPlatformAction({
      platformAdminId: data.platformAdminId,
      action: 'PLATFORM_INCIDENT_TRANSITION',
      resourceType: 'PlatformIncident',
      resourceId: incident.id,
      businessId: incident.businessId,
      reason: data.reason,
      metadata: {
        fromStatus: incident.status,
        toStatus: data.toStatus,
      },
    });
    return updated;
  }

  async addIncidentNote(data: {
    incidentId: string;
    platformAdminId: string;
    note: string;
    metadata?: Record<string, unknown>;
  }) {
    if (!data.note?.trim()) {
      throw new BadRequestException('Note is required.');
    }
    const incident = await this.prisma.platformIncident.findUnique({
      where: { id: data.incidentId },
    });
    if (!incident) {
      throw new BadRequestException('Incident not found.');
    }
    const event = await this.createIncidentEvent({
      incidentId: incident.id,
      eventType: 'NOTE',
      createdByAdminId: data.platformAdminId,
      note: data.note,
      metadata: data.metadata,
    });
    await this.logPlatformAction({
      platformAdminId: data.platformAdminId,
      action: 'PLATFORM_INCIDENT_NOTE',
      resourceType: 'PlatformIncident',
      resourceId: incident.id,
      businessId: incident.businessId,
      reason: data.note,
      metadata: data.metadata,
    });
    return event;
  }

  async updateBusinessReview(data: {
    businessId: string;
    underReview: boolean;
    reason: string;
    severity?: string;
    platformAdminId: string;
    expectedUpdatedAt?: Date | null;
    idempotencyKey?: string;
  }) {
    if (!data.reason) {
      throw new BadRequestException('Reason is required.');
    }
    await this.assertBusinessConcurrency(data.businessId, data.expectedUpdatedAt);
    const idem = await this.claimMutationIdempotency(
      data.businessId,
      'platform:review-update',
      data.idempotencyKey,
    );
    const before = await this.prisma.business.findUnique({
      where: { id: data.businessId },
    });
    const updated = await this.prisma.business.update({
      where: { id: data.businessId },
      data: {
        underReview: data.underReview,
        reviewReason: data.underReview ? data.reason : null,
        reviewSeverity: data.underReview ? (data.severity ?? null) : null,
        reviewedAt: new Date(),
      },
    });
    await this.auditService.logEvent({
      businessId: data.businessId,
      userId: data.platformAdminId,
      action: 'BUSINESS_REVIEW_UPDATE',
      resourceType: 'Business',
      resourceId: data.businessId,
      outcome: 'SUCCESS',
      reason: data.reason,
      before: before as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });
    await this.logPlatformAction({
      platformAdminId: data.platformAdminId,
      action: 'BUSINESS_REVIEW_UPDATE',
      resourceType: 'Business',
      resourceId: data.businessId,
      businessId: data.businessId,
      reason: data.reason,
      metadata: {
        underReview: data.underReview,
        severity: data.severity ?? null,
      },
    });

    if (data.underReview) {
      const legacyIncident = await this.prisma.platformIncident.create({
        data: {
          businessId: data.businessId,
          status: PlatformIncidentStatus.OPEN,
          severity:
            (data.severity as PlatformIncidentSeverity | undefined) ??
            PlatformIncidentSeverity.MEDIUM,
          reason: data.reason,
          title: 'Legacy review flag',
          source: 'LEGACY_REVIEW',
          createdByPlatformAdminId: data.platformAdminId,
          metadata: {
            sourceAction: 'BUSINESS_REVIEW_UPDATE',
          } as Prisma.InputJsonValue,
        },
      });
      await this.createIncidentEvent({
        incidentId: legacyIncident.id,
        eventType: 'LEGACY_FLAG_SET',
        createdByAdminId: data.platformAdminId,
        toStatus: PlatformIncidentStatus.OPEN,
        note: data.reason,
        metadata: {
          severity:
            (data.severity as PlatformIncidentSeverity | undefined) ?? 'MEDIUM',
        },
      });
    } else {
      const active = await this.prisma.platformIncident.findFirst({
        where: {
          businessId: data.businessId,
          status: {
            in: [
              PlatformIncidentStatus.OPEN,
              PlatformIncidentStatus.INVESTIGATING,
              PlatformIncidentStatus.MITIGATED,
            ],
          },
        },
        orderBy: { updatedAt: 'desc' },
      });
      if (active) {
        await this.prisma.platformIncident.update({
          where: { id: active.id },
          data: {
            status: PlatformIncidentStatus.RESOLVED,
            closedAt: active.closedAt ?? new Date(),
            reason: data.reason,
          },
        });
        await this.createIncidentEvent({
          incidentId: active.id,
          eventType: 'LEGACY_FLAG_CLEARED',
          createdByAdminId: data.platformAdminId,
          fromStatus: active.status,
          toStatus: PlatformIncidentStatus.RESOLVED,
          note: data.reason,
        });
      }
    }

    await this.syncBusinessReviewFromIncidents(data.businessId);

    if (idem) {
      await finalizeIdempotency(this.prisma, idem.record.id, {
        resourceType: 'Business',
        resourceId: data.businessId,
        metadata: {
          action: 'BUSINESS_REVIEW_UPDATE',
          underReview: data.underReview,
        },
      });
    }
    return updated;
  }

  async revokeBusinessSessions(data: {
    businessId: string;
    platformAdminId: string;
    reason: string;
    expectedUpdatedAt?: Date | null;
    idempotencyKey?: string;
  }) {
    if (!data.reason) {
      throw new BadRequestException('Reason is required.');
    }
    await this.assertBusinessConcurrency(data.businessId, data.expectedUpdatedAt);
    const idem = await this.claimMutationIdempotency(
      data.businessId,
      'platform:revoke-sessions',
      data.idempotencyKey,
    );
    const users = await this.prisma.businessUser.findMany({
      where: { businessId: data.businessId },
      select: { userId: true },
    });
    const userIds = users.map((entry) => entry.userId);
    const revokedAt = new Date();
    const result = userIds.length
      ? await this.prisma.refreshToken.updateMany({
          where: { userId: { in: userIds }, revokedAt: null },
          data: { revokedAt },
        })
      : { count: 0 };

    await this.logPlatformAction({
      platformAdminId: data.platformAdminId,
      action: 'BUSINESS_FORCE_LOGOUT',
      resourceType: 'Business',
      resourceId: data.businessId,
      businessId: data.businessId,
      reason: data.reason,
      metadata: { revokedCount: result.count },
    });
    if (idem) {
      await finalizeIdempotency(this.prisma, idem.record.id, {
        resourceType: 'Business',
        resourceId: data.businessId,
        metadata: { action: 'BUSINESS_FORCE_LOGOUT', revokedCount: result.count },
      });
    }
    return { revokedCount: result.count };
  }

  async updateRateLimits(data: {
    businessId: string;
    platformAdminId: string;
    limit: number | null;
    ttlSeconds: number | null;
    expiresAt?: Date | null;
    reason: string;
    expectedUpdatedAt?: Date | null;
    idempotencyKey?: string;
  }) {
    if (!data.reason) {
      throw new BadRequestException('Reason is required.');
    }
    await this.assertBusinessConcurrency(data.businessId, data.expectedUpdatedAt);
    const idem = await this.claimMutationIdempotency(
      data.businessId,
      'platform:rate-limit-update',
      data.idempotencyKey,
    );
    const override = {
      limit: data.limit,
      ttlSeconds: data.ttlSeconds,
      expiresAt: data.expiresAt ? data.expiresAt.toISOString() : null,
    };
    const settings = await this.prisma.businessSettings.upsert({
      where: { businessId: data.businessId },
      create: {
        businessId: data.businessId,
        approvalDefaults: DEFAULT_APPROVAL_DEFAULTS,
        notificationDefaults: DEFAULT_NOTIFICATION_SETTINGS,
        stockPolicies: DEFAULT_STOCK_POLICIES,
        posPolicies: DEFAULT_POS_POLICIES,
        localeSettings: DEFAULT_LOCALE_SETTINGS,
        rateLimitOverride: override as Prisma.InputJsonValue,
      },
      update: {
        rateLimitOverride: override as Prisma.InputJsonValue,
      },
    });
    await this.auditService.logEvent({
      businessId: data.businessId,
      userId: data.platformAdminId,
      action: 'RATE_LIMIT_OVERRIDE',
      resourceType: 'BusinessSettings',
      resourceId: settings.id,
      outcome: 'SUCCESS',
      reason: data.reason,
      metadata: override,
    });
    await this.logPlatformAction({
      platformAdminId: data.platformAdminId,
      action: 'RATE_LIMIT_OVERRIDE',
      resourceType: 'BusinessSettings',
      resourceId: settings.id,
      businessId: data.businessId,
      reason: data.reason,
      metadata: { businessId: data.businessId, ...override },
    });
    if (idem) {
      await finalizeIdempotency(this.prisma, idem.record.id, {
        resourceType: 'BusinessSettings',
        resourceId: settings.id,
        metadata: { action: 'RATE_LIMIT_OVERRIDE' },
      });
    }
    return settings;
  }

  async getBusinessActionPreflight(businessId: string, action: string) {
    const normalizedAction = action.trim().toUpperCase();
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      include: {
        subscription: true,
        settings: {
          select: {
            readOnlyEnabled: true,
            readOnlyReason: true,
          },
        },
      },
    });
    if (!business) {
      throw new BadRequestException('Business not found.');
    }

    const [pendingExports, activeDevices, failedOfflineActions, members] =
      await Promise.all([
        this.prisma.exportJob.count({
          where: { businessId, status: 'PENDING' },
        }),
        this.prisma.offlineDevice.count({
          where: { businessId, status: 'ACTIVE' },
        }),
        this.prisma.offlineAction.count({
          where: { businessId, status: 'FAILED' },
        }),
        this.prisma.businessUser.count({ where: { businessId } }),
      ]);

    const preconditions: Array<{
      code: string;
      ok: boolean;
      message: string;
    }> = [];

    if (normalizedAction === 'PURGE') {
      preconditions.push({
        code: 'BUSINESS_ARCHIVED',
        ok: ['ARCHIVED', 'DELETED'].includes(business.status),
        message:
          business.status === 'ARCHIVED' || business.status === 'DELETED'
            ? 'Business status allows purge.'
            : 'Business must be archived before purge.',
      });
    }

    if (normalizedAction === 'DELETE') {
      preconditions.push({
        code: 'FROM_ARCHIVED_ONLY',
        ok: business.status === 'ARCHIVED',
        message:
          business.status === 'ARCHIVED'
            ? 'Business can transition to DELETED.'
            : 'Business must be ARCHIVED before DELETED transition.',
      });
    }

    if (normalizedAction === 'ARCHIVE') {
      preconditions.push({
        code: 'NOT_ALREADY_DELETED',
        ok: business.status !== 'DELETED',
        message:
          business.status === 'DELETED'
            ? 'Deleted business cannot be archived.'
            : 'Business can be archived.',
      });
    }

    return {
      action: normalizedAction,
      business: {
        id: business.id,
        name: business.name,
        status: business.status,
        updatedAt: business.updatedAt.toISOString(),
      },
      impact: {
        users: members,
        pendingExports,
        activeDevices,
        failedOfflineActions,
        currentStatus: business.status,
        readOnlyEnabled: business.settings?.readOnlyEnabled ?? false,
        subscriptionStatus: business.subscription?.status ?? null,
      },
      preconditions,
      ready: preconditions.every((condition) => condition.ok),
      generatedAt: new Date().toISOString(),
    };
  }

  async getPurgePreflight(businessId: string, reason?: string) {
    return this.purgeBusiness(
      businessId,
      'platform-preflight',
      reason ?? 'Purge preflight',
      businessId,
      'DELETE',
      true,
      null,
      undefined,
    );
  }

  async listSubscriptionHistory(businessId: string) {
    return this.prisma.subscriptionHistory.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async revokeOfflineDevice(data: {
    deviceId: string;
    platformAdminId: string;
    reason: string;
  }) {
    if (!data.reason) {
      throw new BadRequestException('Reason is required.');
    }
    const device = await this.prisma.offlineDevice.findUnique({
      where: { id: data.deviceId },
    });
    if (!device) {
      throw new BadRequestException('Device not found.');
    }
    const updated = await this.prisma.offlineDevice.update({
      where: { id: data.deviceId },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    await this.auditService.logEvent({
      businessId: device.businessId,
      userId: data.platformAdminId,
      action: 'OFFLINE_DEVICE_REVOKE',
      resourceType: 'OfflineDevice',
      resourceId: device.id,
      outcome: 'SUCCESS',
      reason: data.reason,
      metadata: { deviceName: device.deviceName },
    });
    await this.logPlatformAction({
      platformAdminId: data.platformAdminId,
      action: 'OFFLINE_DEVICE_REVOKE',
      resourceType: 'OfflineDevice',
      resourceId: device.id,
      businessId: device.businessId,
      reason: data.reason,
      metadata: { businessId: device.businessId },
    });
    return updated;
  }

  async listOfflineDevices(businessId: string) {
    return this.prisma.offlineDevice.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async createAnnouncement(data: {
    title: string;
    message: string;
    severity: string;
    startsAt?: Date;
    endsAt?: Date | null;
    platformAdminId: string;
    reason?: string;
    targetBusinessIds?: string[];
    targetTiers?: string[];
    targetStatuses?: string[];
  }) {
    const businessTargets = Array.from(
      new Set((data.targetBusinessIds ?? []).filter(Boolean)),
    );
    const tierTargets = Array.from(
      new Set((data.targetTiers ?? []).filter(Boolean)),
    );
    const statusTargets = Array.from(
      new Set((data.targetStatuses ?? []).filter(Boolean)),
    );
    const startsAt = data.startsAt ?? new Date();
    const endsAt =
      data.endsAt === undefined
        ? new Date(startsAt.getTime() + 24 * 60 * 60 * 1000)
        : data.endsAt;
    const announcement = await this.prisma.platformAnnouncement.create({
      data: {
        title: data.title,
        message: data.message,
        severity: data.severity,
        startsAt,
        endsAt: endsAt ?? null,
        createdByPlatformAdminId: data.platformAdminId,
        businessTargets: businessTargets.length
          ? {
              createMany: {
                data: businessTargets.map((businessId) => ({ businessId })),
                skipDuplicates: true,
              },
            }
          : undefined,
        segmentTargets:
          tierTargets.length || statusTargets.length
            ? {
                createMany: {
                  data: [
                    ...tierTargets.map((value) => ({
                      type: PlatformAnnouncementSegmentType.TIER,
                      value,
                    })),
                    ...statusTargets.map((value) => ({
                      type: PlatformAnnouncementSegmentType.STATUS,
                      value,
                    })),
                  ],
                  skipDuplicates: true,
                },
              }
            : undefined,
      },
    });
    await this.logPlatformAction({
      platformAdminId: data.platformAdminId,
      action: 'PLATFORM_ANNOUNCEMENT_CREATE',
      resourceType: 'PlatformAnnouncement',
      resourceId: announcement.id,
      reason: data.reason ?? undefined,
      metadata: {
        severity: data.severity,
        endsAt: endsAt ?? null,
        targetBusinessIds: businessTargets,
        targetTiers: tierTargets,
        targetStatuses: statusTargets,
      },
    });
    this.notificationStream.emitAnnouncementChanged({
      id: announcement.id,
      action: 'created',
    });
    return announcement;
  }

  async previewAnnouncementAudience(data: {
    targetBusinessIds?: string[];
    targetTiers?: string[];
    targetStatuses?: string[];
  }) {
    const businessTargets = Array.from(
      new Set((data.targetBusinessIds ?? []).filter(Boolean)),
    );
    const tierTargets = Array.from(
      new Set((data.targetTiers ?? []).filter(Boolean)),
    );
    const statusTargets = Array.from(
      new Set((data.targetStatuses ?? []).filter(Boolean)),
    );
    const explicitBusinesses = businessTargets.length
      ? await this.prisma.business.findMany({
          where: { id: { in: businessTargets } },
          select: {
            id: true,
            name: true,
            status: true,
            subscription: {
              select: {
                tier: true,
                status: true,
              },
            },
          },
        })
      : [];

    const subscriptionFilter: Prisma.SubscriptionWhereInput = {};
    if (tierTargets.length) {
      subscriptionFilter.tier = { in: tierTargets as SubscriptionTier[] };
    }
    if (statusTargets.length) {
      subscriptionFilter.status = {
        in: statusTargets as SubscriptionStatus[],
      };
    }
    const hasSegmentFilter = Boolean(tierTargets.length || statusTargets.length);
    const segmentBusinesses = hasSegmentFilter
      ? await this.prisma.business.findMany({
          where: {
            subscription: {
              is: subscriptionFilter,
            },
          },
          select: {
            id: true,
            name: true,
            status: true,
            subscription: {
              select: {
                tier: true,
                status: true,
              },
            },
          },
        })
      : businessTargets.length
        ? []
        : await this.prisma.business.findMany({
            select: {
              id: true,
              name: true,
              status: true,
              subscription: {
                select: {
                  tier: true,
                  status: true,
                },
              },
            },
          });

    const combinedMap = new Map<
      string,
      {
        id: string;
        name: string;
        status: BusinessStatus;
        subscription: {
          tier: SubscriptionTier;
          status: SubscriptionStatus;
        } | null;
      }
    >();
    explicitBusinesses.forEach((business) => {
      combinedMap.set(business.id, business);
    });
    segmentBusinesses.forEach((business) => {
      combinedMap.set(business.id, business);
    });

    const sampleBusinesses = Array.from(combinedMap.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 20)
      .map((business) => ({
        id: business.id,
        name: business.name,
        businessStatus: business.status,
        subscriptionTier: business.subscription?.tier ?? null,
        subscriptionStatus: business.subscription?.status ?? null,
      }));

    return {
      estimatedReach: {
        total: combinedMap.size,
        explicit: explicitBusinesses.length,
        segment: segmentBusinesses.length,
      },
      filters: {
        hasBroadcastScope: !businessTargets.length && !hasSegmentFilter,
        targetBusinessIds: businessTargets,
        targetTiers: tierTargets,
        targetStatuses: statusTargets,
      },
      sampleBusinesses,
    };
  }

  async listAnnouncements() {
    return this.prisma.platformAnnouncement.findMany({
      include: {
        businessTargets: true,
        segmentTargets: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async endAnnouncement(data: {
    announcementId: string;
    platformAdminId: string;
  }) {
    const announcement = await this.prisma.platformAnnouncement.update({
      where: { id: data.announcementId },
      data: { endsAt: new Date() },
    });
    await this.logPlatformAction({
      platformAdminId: data.platformAdminId,
      action: 'PLATFORM_ANNOUNCEMENT_END',
      resourceType: 'PlatformAnnouncement',
      resourceId: announcement.id,
      metadata: { endsAt: announcement.endsAt },
    });
    this.notificationStream.emitAnnouncementChanged({
      id: announcement.id,
      action: 'ended',
    });
    return announcement;
  }

  async changePlatformAdminPassword(params: {
    platformAdminId: string;
    currentPassword: string;
    newPassword: string;
  }) {
    if (!validatePassword(params.newPassword)) {
      throw new BadRequestException('Password does not meet requirements.');
    }
    const admin = await this.prisma.platformAdmin.findUnique({
      where: { id: params.platformAdminId },
    });
    if (!admin || !verifyPassword(params.currentPassword, admin.passwordHash)) {
      throw new UnauthorizedException('Current password is incorrect.');
    }
    await this.prisma.platformAdmin.update({
      where: { id: admin.id },
      data: {
        passwordHash: hashPassword(params.newPassword),
      },
    });
    await this.logPlatformAction({
      platformAdminId: admin.id,
      action: 'PLATFORM_ADMIN_PASSWORD_CHANGE',
      resourceType: 'PlatformAdmin',
      resourceId: admin.id,
    });
    return { updated: true };
  }

  async getActiveAnnouncement() {
    const now = new Date();
    return this.prisma.platformAnnouncement.findFirst({
      where: {
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gte: now } }],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getBusinessHealth(businessId: string) {
    const [subscription, offlineFailed, exportsPending] = await Promise.all([
      this.prisma.subscription.findUnique({ where: { businessId } }),
      this.prisma.offlineAction.count({
        where: { businessId, status: 'FAILED' },
      }),
      this.prisma.exportJob.count({
        where: { businessId, status: 'PENDING' },
      }),
    ]);
    const baseScore = 100;
    const penalty =
      offlineFailed * 3 +
      exportsPending * 5 +
      (subscription?.status === 'EXPIRED' ? 40 : 0) +
      (subscription?.status === 'GRACE' ? 15 : 0) +
      (subscription?.status === 'SUSPENDED' ? 50 : 0);
    const score = Math.max(0, baseScore - penalty);
    return {
      subscriptionStatus: subscription?.status ?? 'UNKNOWN',
      offlineFailed,
      exportsPending,
      score,
    };
  }

  async getPlatformMetrics(
    range: MetricsRange = '24h',
    from?: Date | null,
    to?: Date | null,
  ) {
    const now = to ?? new Date();
    const rangeConfig = range === 'custom' ? null : RANGE_CONFIG[range];
    const effectiveConfig = rangeConfig ?? { hours: 24, bucketHours: 1 };
    const start =
      range === 'custom'
        ? (from ?? new Date(now.getTime() - 24 * 60 * 60 * 1000))
        : new Date(now.getTime() - effectiveConfig.hours * 60 * 60 * 1000);
    const fallbackConfig = {
      hours: Math.max(
        1,
        Math.ceil((now.getTime() - start.getTime()) / (60 * 60 * 1000)),
      ),
      bucketHours: 1,
    };
    const normalizedConfig =
      range === 'custom' ? fallbackConfig : effectiveConfig;
    const bucketHours = normalizedConfig.bucketHours;
    const bucketCount = Math.ceil(
      (now.getTime() - start.getTime()) / (bucketHours * 60 * 60 * 1000),
    );
    const buckets: MetricsSeriesPoint[] = Array.from(
      { length: bucketCount },
      (_, index) => {
        const labelDate = new Date(
          start.getTime() + index * bucketHours * 60 * 60 * 1000,
        );
        const label =
          bucketHours >= 24
            ? labelDate.toISOString().slice(0, 10)
            : `${labelDate.getHours().toString().padStart(2, '0')}:00`;
        return {
          label,
          errorRate: 0,
          avgLatency: 0,
          offlineFailed: 0,
          exportsPending: 0,
        };
      },
    );

    const [
      metricsRows,
      offlineRows,
      exportRows,
      businessesTotal,
      activeCount,
      graceCount,
      expiredCount,
      suspendedCount,
      reviewCount,
    ] = await this.prisma.$transaction([
      this.prisma.apiMetric.findMany({
        where: { createdAt: { gte: start, lte: now } },
        select: {
          statusCode: true,
          durationMs: true,
          createdAt: true,
          path: true,
        },
      }),
      this.prisma.offlineAction.findMany({
        where: { createdAt: { gte: start, lte: now }, status: 'FAILED' },
        select: { createdAt: true },
      }),
      this.prisma.exportJob.findMany({
        where: { createdAt: { gte: start, lte: now }, status: 'PENDING' },
        select: { createdAt: true },
      }),
      this.prisma.business.count(),
      this.prisma.business.count({ where: { status: 'ACTIVE' } }),
      this.prisma.business.count({ where: { status: 'GRACE' } }),
      this.prisma.business.count({ where: { status: 'EXPIRED' } }),
      this.prisma.business.count({ where: { status: 'SUSPENDED' } }),
      this.prisma.business.count({ where: { underReview: true } }),
    ]);

    const bucketIndex = (date: Date) => {
      const diff = date.getTime() - start.getTime();
      const index = Math.floor(diff / (bucketHours * 60 * 60 * 1000));
      return Math.min(Math.max(index, 0), buckets.length - 1);
    };

    const totals = new Array(bucketCount).fill(0);
    const errors = new Array(bucketCount).fill(0);
    const latencyTotals = new Array(bucketCount).fill(0);

    metricsRows.forEach((row) => {
      const idx = bucketIndex(row.createdAt);
      totals[idx] += 1;
      latencyTotals[idx] += row.durationMs;
      if (row.statusCode >= 400) {
        errors[idx] += 1;
      }
    });

    offlineRows.forEach((row) => {
      const idx = bucketIndex(row.createdAt);
      buckets[idx].offlineFailed += 1;
    });
    exportRows.forEach((row) => {
      const idx = bucketIndex(row.createdAt);
      buckets[idx].exportsPending += 1;
    });

    buckets.forEach((bucket, idx) => {
      const total = totals[idx];
      const errorCount = errors[idx];
      bucket.errorRate = total > 0 ? errorCount / total : 0;
      bucket.avgLatency =
        total > 0 ? Math.round(latencyTotals[idx] / total) : 0;
    });

    const slowEndpoints = metricsRows.reduce<
      Record<string, { durations: number[]; errors: number; count: number }>
    >((acc, row) => {
      acc[row.path] = acc[row.path] ?? { durations: [], errors: 0, count: 0 };
      acc[row.path].durations.push(row.durationMs);
      if (row.statusCode >= 400) {
        acc[row.path].errors += 1;
      }
      acc[row.path].count += 1;
      return acc;
    }, {});
    const slowest = Object.entries(slowEndpoints)
      .map(([path, value]) => ({
        path,
        avgDurationMs: Math.round(
          value.durations.reduce((sum, duration) => sum + duration, 0) /
            Math.max(1, value.count),
        ),
        p95DurationMs: this.percentile(value.durations, 95),
        p99DurationMs: this.percentile(value.durations, 99),
        count: value.count,
        errorRate: value.count > 0 ? value.errors / value.count : 0,
      }))
      .sort(
        (a, b) =>
          b.p95DurationMs - a.p95DurationMs ||
          b.p99DurationMs - a.p99DurationMs ||
          b.avgDurationMs - a.avgDurationMs,
      )
      .slice(0, 5);

    const offlineEnabled = await this.prisma.offlineDevice.count({
      where: { status: 'ACTIVE' },
    });

    const storageUsage = await this.prisma.attachment.groupBy({
      by: ['businessId'],
      _sum: { sizeMb: true },
      orderBy: { _sum: { sizeMb: 'desc' } },
      take: 5,
    });

    const storageTotals = await Promise.all(
      storageUsage.map(async (row) => {
        const business = await this.prisma.business.findUnique({
          where: { id: row.businessId },
          select: { name: true },
        });
        return {
          businessId: row.businessId,
          name: business?.name ?? row.businessId,
          sizeMb: Number(row._sum.sizeMb ?? 0),
        };
      }),
    );

    const totalStorage = storageTotals.reduce(
      (sum, row) => sum + (row.sizeMb ?? 0),
      0,
    );

    return {
      totals: {
        businesses: businessesTotal,
        active: activeCount,
        grace: graceCount,
        expired: expiredCount,
        suspended: suspendedCount,
        underReview: reviewCount,
        offlineEnabled,
      },
      offlineFailures: offlineRows.length,
      exports: {
        pending: exportRows.length,
      },
      api: {
        totalRequests: metricsRows.length,
        errorRate:
          metricsRows.length > 0
            ? metricsRows.filter((row) => row.statusCode >= 400).length /
              metricsRows.length
            : 0,
        avgLatency:
          metricsRows.length > 0
            ? Math.round(
                metricsRows.reduce((sum, row) => sum + row.durationMs, 0) /
                  metricsRows.length,
              )
            : 0,
        p95Latency:
          metricsRows.length > 0
            ? this.percentile(
                metricsRows.map((row) => row.durationMs),
                95,
              )
            : 0,
        p99Latency:
          metricsRows.length > 0
            ? this.percentile(
                metricsRows.map((row) => row.durationMs),
                99,
              )
            : 0,
        slowEndpoints: slowest,
      },
      storage: {
        totalMb: totalStorage,
        topBusinesses: storageTotals,
      },
      series: buckets,
      range: { start: start.toISOString(), end: now.toISOString() },
      timestamp: new Date().toISOString(),
    };
  }
}
