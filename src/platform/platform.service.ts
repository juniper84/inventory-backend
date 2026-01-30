import {
  BadRequestException,
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
import { hashPassword, validatePassword, verifyPassword } from '../auth/password';
import {
  BusinessStatus,
  ExportJobStatus,
  ExportJobType,
  Prisma,
  PlatformAnnouncementSegmentType,
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

const RANGE_CONFIG: Record<
  Exclude<MetricsRange, 'custom'>,
  { hours: number; bucketHours: number }
> = {
  '24h': { hours: 24, bucketHours: 1 },
  '7d': { hours: 24 * 7, bucketHours: 24 },
  '30d': { hours: 24 * 30, bucketHours: 24 },
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
                  { name: { contains: search, mode: Prisma.QueryMode.insensitive } },
                  { id: { contains: search, mode: Prisma.QueryMode.insensitive } },
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

  async updateBusinessStatus(
    businessId: string,
    status: BusinessStatus,
    platformAdminId: string,
    reason?: string,
  ) {
    if (!reason) {
      throw new BadRequestException('Reason is required.');
    }
    const before = await this.prisma.business.findUnique({
      where: { id: businessId },
    });
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
    return updated;
  }

  async purgeBusiness(
    businessId: string,
    platformAdminId: string,
    reason?: string,
    confirmBusinessId?: string,
    confirmText?: string,
    dryRun?: boolean,
  ) {
    if (!reason) {
      throw new BadRequestException('Reason is required.');
    }
    if (!dryRun) {
      if (confirmBusinessId !== businessId) {
        throw new BadRequestException('Business ID confirmation does not match.');
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
    },
  ) {
    if (!data.reason) {
      throw new BadRequestException('Reason is required.');
    }
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
    return Promise.all([existing, subscription]).then(([before, after]) => {
      if (after.status === SubscriptionStatus.EXPIRED) {
        this.prisma.offlineDevice.updateMany({
          where: { businessId, status: 'ACTIVE' },
          data: { status: 'REVOKED', revokedAt: new Date() },
        });
      }
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
      });
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
      });
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
      });

      if (
        data.status === SubscriptionStatus.GRACE &&
        before?.status !== SubscriptionStatus.GRACE
      ) {
        const graceEndsAt = data.graceEndsAt ?? before?.graceEndsAt ?? null;
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
        });
      }

      return after;
    });
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
    data: { enabled: boolean; reason?: string | null; platformAdminId: string },
  ) {
    if (data.enabled && !data.reason) {
      throw new BadRequestException('Reason is required.');
    }
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

  async updateBusinessReview(data: {
    businessId: string;
    underReview: boolean;
    reason: string;
    severity?: string;
    platformAdminId: string;
  }) {
    if (!data.reason) {
      throw new BadRequestException('Reason is required.');
    }
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
    return updated;
  }

  async revokeBusinessSessions(data: {
    businessId: string;
    platformAdminId: string;
    reason: string;
  }) {
    if (!data.reason) {
      throw new BadRequestException('Reason is required.');
    }
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
    return { revokedCount: result.count };
  }

  async updateRateLimits(data: {
    businessId: string;
    platformAdminId: string;
    limit: number | null;
    ttlSeconds: number | null;
    expiresAt?: Date | null;
    reason: string;
  }) {
    if (!data.reason) {
      throw new BadRequestException('Reason is required.');
    }
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
    return settings;
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
      data.endsAt === undefined ? new Date(startsAt.getTime() + 24 * 60 * 60 * 1000) : data.endsAt;
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

  async endAnnouncement(data: { announcementId: string; platformAdminId: string }) {
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
      Record<string, { total: number; count: number }>
    >((acc, row) => {
      acc[row.path] = acc[row.path] ?? { total: 0, count: 0 };
      acc[row.path].total += row.durationMs;
      acc[row.path].count += 1;
      return acc;
    }, {});
    const slowest = Object.entries(slowEndpoints)
      .map(([path, value]) => ({
        path,
        avgDurationMs: Math.round(value.total / value.count),
        count: value.count,
      }))
      .sort((a, b) => b.avgDurationMs - a.avgDurationMs)
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
