import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Notification, NotificationPriority, NotificationStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  NotificationChannel,
  NotificationEventKey,
  NotificationRecipientConfig,
  NotificationSettings,
  normalizeNotificationSettings,
  resolveNotificationGroup,
} from './notification-config';
import { WhatsAppService } from './whatsapp.service';
import { SmsService } from './sms.service';
import { labelWithFallback } from '../common/labels';
import { resolveResourceName } from '../common/resource-labels';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';
import { MailerService } from '../mailer/mailer.service';
import { I18nService } from '../i18n/i18n.service';
import { buildBrandedEmail } from '../mailer/email-templates';
import { NotificationStreamService } from './notification-stream.service';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly whatsappService?: WhatsAppService,
    private readonly smsService?: SmsService,
    private readonly mailerService?: MailerService,
    private readonly i18n?: I18nService,
    private readonly configService?: ConfigService,
    private readonly notificationStream?: NotificationStreamService,
  ) {}

  private buildNotificationUrl(metadata?: Record<string, unknown> | null) {
    const direct =
      typeof metadata?.url === 'string'
        ? metadata.url
        : typeof metadata?.link === 'string'
          ? metadata.link
          : null;
    if (direct) {
      return direct;
    }
    const path = typeof metadata?.path === 'string' ? metadata.path : null;
    const appBaseUrl = this.configService?.get<string>('appBaseUrl') || '';
    if (path && appBaseUrl) {
      return `${appBaseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    }
    return null;
  }

  private async getNotificationSettings(
    businessId: string,
  ): Promise<NotificationSettings> {
    const settings = await this.prisma.businessSettings.findUnique({
      where: { businessId },
      select: { notificationDefaults: true },
    });
    return normalizeNotificationSettings(
      settings?.notificationDefaults as Record<string, unknown> | null,
    );
  }

  async isEventEnabled(businessId: string, key: NotificationEventKey) {
    const settings = await this.getNotificationSettings(businessId);
    return settings.events[key]?.enabled !== false;
  }

  list(
    businessId: string,
    userId?: string,
    roleIds?: string[],
    branchScope?: string[],
    permissions?: string[],
    query: PaginationQuery & {
      search?: string;
      status?: string;
      priority?: string;
      from?: string;
      to?: string;
      includeTotal?: string;
      includeArchived?: string;
    } = {},
  ) {
    const pagination = parsePagination(query);
    const search = query.search?.trim();
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    const orFilters: Prisma.NotificationWhereInput[] = [];
    if (userId) {
      orFilters.push({ userId });
    }
    if (roleIds?.length) {
      orFilters.push({ roleId: { in: roleIds } });
    }
    if (branchScope?.length) {
      orFilters.push({ branchId: { in: branchScope } });
    }
    if (permissions?.length) {
      orFilters.push({ permission: { in: permissions } });
    }
    orFilters.push({
      userId: null,
      roleId: null,
      branchId: null,
      permission: null,
    });
    const normalizedStatus =
      query.status &&
      Object.values(NotificationStatus).includes(
        query.status as NotificationStatus,
      )
        ? (query.status as NotificationStatus)
        : undefined;
    const normalizedPriority =
      query.priority &&
      Object.values(NotificationPriority).includes(
        query.priority as NotificationPriority,
      )
        ? (query.priority as NotificationPriority)
        : undefined;
    const includeArchived =
      query.includeArchived === 'true' || query.includeArchived === '1';
    const where: Prisma.NotificationWhereInput = {
      businessId,
      ...(normalizedStatus ? { status: normalizedStatus } : {}),
      ...(normalizedPriority ? { priority: normalizedPriority } : {}),
      ...(includeArchived ? {} : { archivedAt: null }),
      AND: [
        { OR: orFilters },
        ...(search
          ? [
              {
                OR: [
                  { title: { contains: search, mode: Prisma.QueryMode.insensitive } },
                  { message: { contains: search, mode: Prisma.QueryMode.insensitive } },
                ],
              },
            ]
          : []),
        ...(from || to
          ? [
              {
                createdAt: {
                  ...(from ? { gte: from } : {}),
                  ...(to ? { lte: to } : {}),
                },
              },
            ]
          : []),
      ],
    };
    const includeTotal =
      query.includeTotal === 'true' || query.includeTotal === '1';
    return Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...pagination,
      }),
      includeTotal
        ? this.prisma.notification.count({ where })
        : Promise.resolve(null),
    ]).then(([items, total]) =>
      buildPaginatedResponse(
        items,
        pagination.take,
        typeof total === 'number' ? total : undefined,
      ),
    );
  }

  async markRead(businessId: string, notificationId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id: notificationId, businessId, archivedAt: null },
    });
    if (!notification) {
      return null;
    }
    const updated = await this.prisma.notification.update({
      where: { id: notificationId },
      data: { status: 'READ', readAt: new Date() },
    });
    await this.auditService.logEvent({
      businessId,
      userId: notification.userId ?? undefined,
      action: 'NOTIFICATION_READ',
      resourceType: 'Notification',
      resourceId: notificationId,
      outcome: 'SUCCESS',
      metadata: { priority: notification.priority },
    });
    return updated;
  }

  async markAllRead(businessId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { businessId, status: { not: NotificationStatus.READ }, archivedAt: null },
      data: { status: NotificationStatus.READ, readAt: new Date() },
    });
    return { count: result.count };
  }

  async markBulkRead(businessId: string, ids: string[]) {
    if (!ids.length) {
      return { count: 0 };
    }
    const result = await this.prisma.notification.updateMany({
      where: {
        businessId,
        id: { in: ids },
        archivedAt: null,
      },
      data: { status: NotificationStatus.READ, readAt: new Date() },
    });
    return { count: result.count };
  }

  async archiveBulk(businessId: string, ids: string[]) {
    if (!ids.length) {
      return { count: 0 };
    }
    const result = await this.prisma.notification.updateMany({
      where: {
        businessId,
        id: { in: ids },
        archivedAt: null,
      },
      data: { archivedAt: new Date() },
    });
    return { count: result.count };
  }

  async getActiveAnnouncement(businessId?: string) {
    const now = new Date();
    const subscription = businessId
      ? await this.prisma.subscription.findUnique({
          where: { businessId },
          select: { tier: true, status: true },
        })
      : null;
    const tier = subscription?.tier ?? null;
    const status = subscription?.status ?? null;
    const targetFilters: Prisma.PlatformAnnouncementWhereInput[] = [
      {
        businessTargets: { none: {} },
        segmentTargets: { none: {} },
      },
    ];
    if (businessId) {
      targetFilters.push({
        businessTargets: { some: { businessId } },
      });
    }
    if (tier) {
      targetFilters.push({
        segmentTargets: { some: { type: 'TIER', value: tier } },
      });
    }
    if (status) {
      targetFilters.push({
        segmentTargets: { some: { type: 'STATUS', value: status } },
      });
    }
    return this.prisma.platformAnnouncement.findFirst({
      where: {
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gte: now } }],
        AND: [{ OR: targetFilters }],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async getSubscriptionTier(businessId: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { businessId },
      select: { tier: true },
    });
    return subscription?.tier ?? null;
  }

  private parseUserPreferences(
    raw: Record<string, unknown> | null | undefined,
  ) {
    if (!raw || typeof raw !== 'object') {
      return { channels: {}, events: {} } as {
        channels: Partial<Record<NotificationChannel, boolean>>;
        events: Record<string, boolean>;
      };
    }
    const input = raw;
    const channels =
      typeof input.channels === 'object' && input.channels !== null
        ? (input.channels as Record<string, boolean>)
        : input;
    const events =
      typeof input.events === 'object' && input.events !== null
        ? (input.events as Record<string, boolean>)
        : {};
    return {
      channels: {
        email: typeof channels.email === 'boolean' ? channels.email : undefined,
        sms: typeof channels.sms === 'boolean' ? channels.sms : undefined,
        whatsapp:
          typeof channels.whatsapp === 'boolean'
            ? channels.whatsapp
            : undefined,
      },
      events: events ?? {},
    };
  }

  private allowUserEvent(
    preferences: ReturnType<typeof this.parseUserPreferences>,
    eventKey: NotificationEventKey,
  ) {
    return preferences.events[eventKey] !== false;
  }

  private allowUserChannel(
    preferences: ReturnType<typeof this.parseUserPreferences>,
    channel: NotificationChannel,
  ) {
    const value = preferences.channels[channel];
    return value !== false;
  }

  private async resolveRecipientUserIds(params: {
    businessId: string;
    branchIds: string[];
    recipients: NotificationRecipientConfig;
    explicitUserIds?: string[];
  }) {
    const { businessId, branchIds, recipients, explicitUserIds = [] } = params;
    const roleIds = new Set(recipients.roleIds);
    const extraRoleNames: string[] = [];
    if (recipients.includeOwners) {
      extraRoleNames.push('System Owner');
    }
    if (recipients.includeManagers) {
      extraRoleNames.push('Manager');
    }
    if (extraRoleNames.length) {
      const extraRoles = await this.prisma.role.findMany({
        where: { businessId, name: { in: extraRoleNames } },
        select: { id: true },
      });
      for (const role of extraRoles) {
        roleIds.add(role.id);
      }
    }

    const userIds = new Set(explicitUserIds);

    if (roleIds.size) {
      const assignments = await this.prisma.userRole.findMany({
        where: { roleId: { in: Array.from(roleIds) } },
        select: { userId: true, branchId: true },
      });
      for (const assignment of assignments) {
        if (recipients.branchScoped && branchIds.length) {
          if (assignment.branchId && !branchIds.includes(assignment.branchId)) {
            continue;
          }
        }
        userIds.add(assignment.userId);
      }
    }

    for (const userId of recipients.userIds) {
      userIds.add(userId);
    }

    if (recipients.branchScoped && branchIds.length && userIds.size) {
      const scoped = await this.prisma.userRole.findMany({
        where: {
          userId: { in: Array.from(userIds) },
          role: { businessId },
          OR: [{ branchId: null }, { branchId: { in: branchIds } }],
        },
        select: { userId: true },
      });
      const allowed = new Set(scoped.map((entry) => entry.userId));
      for (const userId of Array.from(userIds)) {
        if (!allowed.has(userId)) {
          userIds.delete(userId);
        }
      }
    }

    return userIds;
  }

  private async loadRecipientUsers(businessId: string, userIds: string[]) {
    if (!userIds.length) {
      return [];
    }
    return this.prisma.businessUser.findMany({
      where: {
        businessId,
        status: 'ACTIVE',
        userId: { in: userIds },
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            phone: true,
            notificationPreferences: true,
          },
        },
      },
    });
  }

  private async enrichPayload(data: {
    businessId: string;
    userId?: string;
    roleId?: string;
    branchId?: string;
    permission?: string;
    title: string;
    message: string;
    priority: 'ACTION_REQUIRED' | 'WARNING' | 'INFO' | 'SECURITY';
    metadata?: Record<string, unknown>;
  }) {
    let metadata = data.metadata ? { ...data.metadata } : undefined;
    const replacements: Array<{ id: string; label: string }> = [];
    const variantId =
      metadata && typeof metadata.variantId === 'string'
        ? metadata.variantId
        : null;
    if (variantId) {
      const variant = await this.prisma.variant.findFirst({
        where: { id: variantId, businessId: data.businessId },
        select: { name: true, product: { select: { name: true } } },
      });
      if (variant) {
        const variantName = labelWithFallback({
          name: variant.name,
          id: variantId,
        });
        const productName = variant.product?.name?.trim() ?? null;
        const displayName = productName
          ? `${productName} - ${variantName}`
          : variantName;
        const existingType =
          metadata && typeof metadata.resourceType === 'string'
            ? metadata.resourceType
            : null;
        metadata = {
          ...(metadata ?? {}),
          variantName,
          ...(productName ? { productName } : {}),
          resourceType: existingType ?? 'Variant',
          resourceId: metadata?.resourceId ?? variantId,
          resourceName: metadata?.resourceName ?? displayName,
        };
        replacements.push({ id: variantId, label: displayName });
      }
    }

    const productId =
      metadata && typeof metadata.productId === 'string'
        ? metadata.productId
        : null;
    if (productId) {
      const product = await this.prisma.product.findFirst({
        where: { id: productId, businessId: data.businessId },
        select: { name: true },
      });
      if (product) {
        const productName = labelWithFallback({
          name: product.name,
          id: productId,
        });
        const existingType =
          metadata && typeof metadata.resourceType === 'string'
            ? metadata.resourceType
            : null;
        metadata = {
          ...(metadata ?? {}),
          productName,
          resourceType: existingType ?? 'Product',
          resourceId: metadata?.resourceId ?? productId,
          resourceName: metadata?.resourceName ?? productName,
        };
        replacements.push({ id: productId, label: productName });
      }
    }

    const resourceType =
      metadata && typeof metadata.resourceType === 'string'
        ? metadata.resourceType
        : null;
    const resourceId =
      metadata && typeof metadata.resourceId === 'string'
        ? metadata.resourceId
        : null;
    if (!resourceType || !resourceId) {
      const keyMap: Array<{ key: string; type: string }> = [
        { key: 'approvalId', type: 'Approval' },
        { key: 'transferId', type: 'Transfer' },
        { key: 'purchaseId', type: 'Purchase' },
        { key: 'purchaseOrderId', type: 'PurchaseOrder' },
        { key: 'supplierReturnId', type: 'SupplierReturn' },
        { key: 'expenseId', type: 'Expense' },
        { key: 'saleId', type: 'Sale' },
        { key: 'saleRefundId', type: 'SaleRefund' },
        { key: 'saleSettlementId', type: 'SaleSettlement' },
        { key: 'receiptId', type: 'Receipt' },
        { key: 'movementId', type: 'StockMovement' },
        { key: 'batchId', type: 'Batch' },
        { key: 'offlineDeviceId', type: 'OfflineDevice' },
      ];
      for (const entry of keyMap) {
        const value =
          metadata && typeof metadata[entry.key] === 'string'
            ? (metadata[entry.key] as string)
            : null;
        if (value) {
          metadata = {
            ...(metadata ?? {}),
            resourceType: resourceType ?? entry.type,
            resourceId: resourceId ?? value,
          };
          break;
        }
      }
    }
    const resolvedType =
      metadata && typeof metadata.resourceType === 'string'
        ? metadata.resourceType
        : null;
    const resolvedId =
      metadata && typeof metadata.resourceId === 'string'
        ? metadata.resourceId
        : null;
    if (
      resolvedType &&
      resolvedId &&
      typeof metadata?.resourceName !== 'string'
    ) {
      const resourceName = await resolveResourceName(this.prisma, {
        businessId: data.businessId,
        resourceType: resolvedType,
        resourceId: resolvedId,
      });
      if (resourceName) {
        metadata = { ...(metadata ?? {}), resourceName };
        replacements.push({ id: resolvedId, label: resourceName });
      }
    }

    let message = data.message;
    for (const replacement of replacements) {
      if (replacement.id && message.includes(replacement.id)) {
        message = message.split(replacement.id).join(replacement.label);
      }
    }

    return { message, metadata };
  }

  private async createNotificationRecord(data: {
    businessId: string;
    userId?: string;
    roleId?: string;
    branchId?: string;
    permission?: string;
    title: string;
    message: string;
    priority: 'ACTION_REQUIRED' | 'WARNING' | 'INFO' | 'SECURITY';
    metadata?: Record<string, unknown>;
  }) {
    const enriched = await this.enrichPayload(data);
    const created = await this.prisma.notification.create({
      data: {
        businessId: data.businessId,
        userId: data.userId ?? null,
        roleId: data.roleId ?? null,
        branchId: data.branchId ?? null,
        permission: data.permission ?? null,
        title: data.title,
        message: enriched.message,
        priority: data.priority,
        metadata: enriched.metadata
          ? (enriched.metadata as Prisma.InputJsonValue)
          : undefined,
      },
    });

    await this.auditService.logEvent({
      businessId: data.businessId,
      userId: data.userId,
      action: 'NOTIFICATION_CREATE',
      resourceType: 'Notification',
      resourceId: created.id,
      outcome: 'SUCCESS',
      metadata: {
        priority: data.priority,
        roleId: data.roleId ?? null,
        branchId: data.branchId ?? null,
        permission: data.permission ?? null,
      },
    });

    this.notificationStream?.emit(created);

    return { created, enriched };
  }

  private resolveChannelFlags(params: {
    settings: NotificationSettings;
    groupSettings?: { channels: Record<NotificationChannel, boolean> };
    overrides?: Partial<Record<NotificationChannel, boolean>>;
    tier: string | null;
  }) {
    const { settings, groupSettings, overrides, tier } = params;
    const base = {
      email: settings.channels.email,
      sms: settings.channels.sms,
      whatsapp: settings.channels.whatsapp,
    };
    const combined = {
      email: base.email && (groupSettings?.channels.email ?? true),
      sms: base.sms && (groupSettings?.channels.sms ?? true),
      whatsapp: base.whatsapp && (groupSettings?.channels.whatsapp ?? true),
    };
    if (tier !== 'ENTERPRISE') {
      combined.sms = false;
      combined.whatsapp = false;
    }
    if (overrides) {
      if (overrides.email === false) {
        combined.email = false;
      }
      if (overrides.sms === false) {
        combined.sms = false;
      }
      if (overrides.whatsapp === false) {
        combined.whatsapp = false;
      }
    }
    return combined;
  }

  async notifyEvent(data: {
    businessId: string;
    eventKey: NotificationEventKey;
    title: string;
    message: string;
    priority: 'ACTION_REQUIRED' | 'WARNING' | 'INFO' | 'SECURITY';
    metadata?: Record<string, unknown>;
    actorUserId?: string;
    recipientUserIds?: string[];
    branchId?: string;
    branchIds?: string[];
    channelOverrides?: Partial<Record<NotificationChannel, boolean>>;
  }) {
    const settings = await this.getNotificationSettings(data.businessId);
    const eventSettings = settings.events[data.eventKey];
    if (!eventSettings?.enabled) {
      return [];
    }

    const groupKey = resolveNotificationGroup(data.eventKey);
    const groupSettings = settings.groups[groupKey];
    const branchIds = data.branchIds?.length
      ? data.branchIds
      : data.branchId
        ? [data.branchId]
        : [];
    const explicitUserIds = [
      ...(data.recipientUserIds ?? []),
      ...(data.actorUserId ? [data.actorUserId] : []),
    ];

    const globalRecipientIds = await this.resolveRecipientUserIds({
      businessId: data.businessId,
      branchIds,
      recipients: settings.recipients.global,
      explicitUserIds,
    });
    const emailRecipientIds = settings.recipients.email
      ? await this.resolveRecipientUserIds({
          businessId: data.businessId,
          branchIds,
          recipients: settings.recipients.email,
          explicitUserIds,
        })
      : globalRecipientIds;
    const whatsappRecipientIds = settings.recipients.whatsapp
      ? await this.resolveRecipientUserIds({
          businessId: data.businessId,
          branchIds,
          recipients: settings.recipients.whatsapp,
          explicitUserIds,
        })
      : globalRecipientIds;
    const smsRecipientIds = settings.recipients.sms
      ? await this.resolveRecipientUserIds({
          businessId: data.businessId,
          branchIds,
          recipients: settings.recipients.sms,
          explicitUserIds,
        })
      : globalRecipientIds;
    const recipientIds = new Set<string>([
      ...globalRecipientIds,
      ...emailRecipientIds,
      ...whatsappRecipientIds,
      ...smsRecipientIds,
    ]);
    if (!recipientIds.size) {
      return [];
    }

    const recipients = await this.loadRecipientUsers(
      data.businessId,
      Array.from(recipientIds),
    );
    if (!recipients.length) {
      return [];
    }

    const tier = await this.getSubscriptionTier(data.businessId);
    const channelFlags = this.resolveChannelFlags({
      settings,
      groupSettings,
      overrides: data.channelOverrides,
      tier,
    });

    const emailSet = new Set(emailRecipientIds);
    const whatsappSet = new Set(whatsappRecipientIds);
    const smsSet = new Set(smsRecipientIds);

    const results: Notification[] = [];
    for (const membership of recipients) {
      const preferences = this.parseUserPreferences(
        membership.user.notificationPreferences as Record<
          string,
          unknown
        > | null,
      );
      if (!this.allowUserEvent(preferences, data.eventKey)) {
        continue;
      }

      const { created, enriched } = await this.createNotificationRecord({
        businessId: data.businessId,
        userId: membership.user.id,
        branchId: branchIds.length === 1 ? branchIds[0] : undefined,
        title: data.title,
        message: data.message,
        priority: data.priority,
        metadata: { ...(data.metadata ?? {}), eventKey: data.eventKey },
      });

      if (
        channelFlags.email &&
        membership.user.email &&
        emailSet.has(membership.user.id) &&
        this.allowUserChannel(preferences, 'email')
      ) {
        try {
          const locale: 'en' = 'en';
          const ctaUrl = this.buildNotificationUrl(
            (enriched.metadata as Record<string, unknown> | null) ?? null,
          );
          const ctaLabel = ctaUrl
            ? this.i18n?.t(locale, 'email.common.notificationCta') ??
              'Open New Vision Inventory'
            : undefined;
          const emailPayload = buildBrandedEmail({
            subject: data.title,
            title: data.title,
            body: enriched.message,
            ctaLabel,
            ctaUrl: ctaUrl || undefined,
            brandName: this.i18n?.t(locale, 'email.common.brandName') ??
              'New Vision Inventory',
            supportLine: this.i18n?.t(locale, 'email.common.supportLine'),
            securityLine: this.i18n?.t(locale, 'email.common.securityLine'),
            footerLine: this.i18n?.t(locale, 'email.common.footerLine', {
              year: new Date().getFullYear(),
            }),
            preheader: data.title,
          });
          const response = await this.mailerService?.sendEmail({
            to: membership.user.email,
            ...emailPayload,
          });
          if ((response as { skipped?: boolean })?.skipped) {
            // ignore if not configured
          }
        } catch {
          // Email delivery failures should not block notification creation.
        }
      }
      if (
        channelFlags.sms &&
        this.smsService?.isEnabled() &&
        membership.user.phone &&
        smsSet.has(membership.user.id) &&
        this.allowUserChannel(preferences, 'sms')
      ) {
        try {
          await this.smsService.sendMessage({
            to: membership.user.phone,
            body: `${data.title}\n${enriched.message}`.trim(),
          });
        } catch {
          // SMS delivery failures should not block notification creation.
        }
      }
      if (
        channelFlags.whatsapp &&
        this.whatsappService?.isEnabled() &&
        membership.user.phone &&
        whatsappSet.has(membership.user.id) &&
        this.allowUserChannel(preferences, 'whatsapp')
      ) {
        try {
          await this.whatsappService.sendMessage({
            to: membership.user.phone,
            body: `${data.title}\n${enriched.message}`.trim(),
          });
        } catch {
          // WhatsApp delivery failures should not block notification creation.
        }
      }

      results.push(created);
    }

    return results;
  }

  async create(data: {
    businessId: string;
    userId?: string;
    roleId?: string;
    branchId?: string;
    permission?: string;
    title: string;
    message: string;
    priority: 'ACTION_REQUIRED' | 'WARNING' | 'INFO' | 'SECURITY';
    metadata?: Record<string, unknown>;
  }) {
    const { created, enriched } = await this.createNotificationRecord(data);
    if (!data.userId) {
      return created;
    }

    const settings = await this.getNotificationSettings(data.businessId);
    const tier = await this.getSubscriptionTier(data.businessId);
    const channelFlags = this.resolveChannelFlags({
      settings,
      overrides: undefined,
      tier,
    });
    const membership = await this.loadRecipientUsers(data.businessId, [
      data.userId,
    ]);
    const user = membership[0]?.user;
    if (!user) {
      return created;
    }
    const preferences = this.parseUserPreferences(
      user.notificationPreferences as Record<string, unknown> | null,
    );
    if (
      channelFlags.email &&
      user.email &&
      this.allowUserChannel(preferences, 'email')
    ) {
      try {
        const locale: 'en' = 'en';
        const ctaUrl = this.buildNotificationUrl(
          (enriched.metadata as Record<string, unknown> | null) ?? null,
        );
        const ctaLabel = ctaUrl
          ? this.i18n?.t(locale, 'email.common.notificationCta') ??
            'Open New Vision Inventory'
          : undefined;
        const emailPayload = buildBrandedEmail({
          subject: data.title,
          title: data.title,
          body: enriched.message,
          ctaLabel,
          ctaUrl: ctaUrl || undefined,
          brandName: this.i18n?.t(locale, 'email.common.brandName') ??
            'New Vision Inventory',
          supportLine: this.i18n?.t(locale, 'email.common.supportLine'),
          securityLine: this.i18n?.t(locale, 'email.common.securityLine'),
          footerLine: this.i18n?.t(locale, 'email.common.footerLine', {
            year: new Date().getFullYear(),
          }),
          preheader: data.title,
        });
        const response = await this.mailerService?.sendEmail({
          to: user.email,
          ...emailPayload,
        });
        if ((response as { skipped?: boolean })?.skipped) {
          // ignore if not configured
        }
      } catch {
        // Email delivery failures should not block notification creation.
      }
    }
    if (
      channelFlags.sms &&
      this.smsService?.isEnabled() &&
      user.phone &&
      this.allowUserChannel(preferences, 'sms')
    ) {
      try {
        await this.smsService.sendMessage({
          to: user.phone,
          body: `${data.title}\n${enriched.message}`.trim(),
        });
      } catch {
        // SMS delivery failures should not block notification creation.
      }
    }
    if (
      channelFlags.whatsapp &&
      this.whatsappService?.isEnabled() &&
      user.phone &&
      this.allowUserChannel(preferences, 'whatsapp')
    ) {
      try {
        await this.whatsappService.sendMessage({
          to: user.phone,
          body: `${data.title}\n${enriched.message}`.trim(),
        });
      } catch {
        // WhatsApp delivery failures should not block notification creation.
      }
    }

    return created;
  }
}
