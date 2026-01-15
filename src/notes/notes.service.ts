import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Prisma, RecordStatus, SubscriptionTier } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';
import { resolveResourceName } from '../common/resource-labels';
import { SubscriptionService } from '../subscription/subscription.service';

type NoteLinkInput = {
  resourceType: string;
  resourceId: string;
};

type NoteCreateInput = {
  title: string;
  body: string;
  visibility?: 'PRIVATE' | 'BRANCH' | 'BUSINESS';
  branchId?: string | null;
  tags?: string[];
  links?: NoteLinkInput[];
};

type NoteUpdateInput = {
  title?: string;
  body?: string;
  visibility?: 'PRIVATE' | 'BRANCH' | 'BUSINESS';
  branchId?: string | null;
  status?: RecordStatus;
  tags?: string[];
  links?: NoteLinkInput[];
};

type ReminderCreateInput = {
  scheduledAt: string;
  channels: Array<'IN_APP' | 'EMAIL' | 'WHATSAPP'>;
  recipientId?: string;
  branchId?: string;
};

type NotesListQuery = PaginationQuery & {
  status?: string;
  search?: string;
  tag?: string;
  visibility?: string;
  branchId?: string;
  resourceType?: string;
  resourceId?: string;
  includeTotal?: string;
};

type ViewerContext = {
  userId: string;
  canManage: boolean;
  branchScope: string[];
};

const ALLOWED_LINK_TYPES = new Set([
  'Product',
  'Variant',
  'Branch',
  'Supplier',
  'Customer',
  'PurchaseOrder',
  'Purchase',
  'Transfer',
  'StockMovement',
  'StockAdjustment',
  'StockCount',
  'Sale',
  'Receipt',
]);

const CHANNEL_RULES: Record<
  SubscriptionTier,
  Array<'IN_APP' | 'EMAIL' | 'WHATSAPP'>
> = {
  STARTER: [],
  BUSINESS: ['IN_APP', 'EMAIL'],
  ENTERPRISE: ['IN_APP', 'EMAIL', 'WHATSAPP'],
};

@Injectable()
export class NotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  private normalizeTags(tags?: string[]) {
    if (!tags?.length) {
      return [];
    }
    const cleaned = tags
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    return Array.from(new Set(cleaned)).slice(0, 20);
  }

  private buildVisibilityFilter(context: ViewerContext): Prisma.NoteWhereInput {
    if (context.canManage) {
      return {};
    }
    const orFilters: Prisma.NoteWhereInput[] = [
      { visibility: 'BUSINESS' },
      { visibility: 'PRIVATE', authorId: context.userId },
    ];
    if (context.branchScope.length) {
      orFilters.push({
        visibility: 'BRANCH',
        branchId: { in: context.branchScope },
      });
    } else {
      orFilters.push({ visibility: 'BRANCH' });
    }
    orFilters.push({ authorId: context.userId });
    return { OR: orFilters };
  }

  private async resolveLinks(
    businessId: string,
    links?: NoteLinkInput[],
  ): Promise<
    Array<{ resourceType: string; resourceId: string; resourceName?: string }>
  > {
    if (!links?.length) {
      return [];
    }
    const resolved: Array<{
      resourceType: string;
      resourceId: string;
      resourceName?: string;
    }> = [];
    for (const link of links) {
      const resourceType = link.resourceType?.trim();
      const resourceId = link.resourceId?.trim();
      if (!resourceType || !resourceId) {
        throw new BadRequestException('Link requires resource type and id.');
      }
      if (!ALLOWED_LINK_TYPES.has(resourceType)) {
        throw new BadRequestException(`Unsupported link type: ${resourceType}`);
      }
      const resourceName = await resolveResourceName(this.prisma, {
        businessId,
        resourceType,
        resourceId,
      });
      if (!resourceName) {
        throw new BadRequestException(`Unknown resource for ${resourceType}.`);
      }
      resolved.push({ resourceType, resourceId, resourceName });
    }
    return resolved;
  }

  private async assertReminderChannel(
    businessId: string,
    channel: 'IN_APP' | 'EMAIL' | 'WHATSAPP',
  ) {
    const subscription =
      await this.subscriptionService.getSubscription(businessId);
    if (!subscription) {
      throw new BadRequestException('Subscription not found.');
    }
    const allowed = CHANNEL_RULES[subscription.tier] || [];
    if (!allowed.includes(channel)) {
      throw new BadRequestException(
        'Reminder channel not available for this tier.',
      );
    }
  }

  async listNotes(
    businessId: string,
    context: ViewerContext,
    query: NotesListQuery,
  ) {
    const pagination = parsePagination(query);
    const search = query.search?.trim();
    const tag = query.tag?.trim();
    const visibility = query.visibility?.trim();
    const resourceType = query.resourceType?.trim();
    const resourceId = query.resourceId?.trim();
    const includeTotal =
      query.includeTotal === 'true' || query.includeTotal === '1';

    if (
      query.branchId &&
      context.branchScope.length > 0 &&
      !context.branchScope.includes(query.branchId) &&
      !context.canManage
    ) {
      return buildPaginatedResponse(
        [],
        pagination.take,
        includeTotal ? 0 : undefined,
      );
    }

    const where: Prisma.NoteWhereInput = {
      businessId,
      ...(query.status ? { status: query.status as RecordStatus } : {}),
      ...(visibility ? { visibility: visibility as any } : {}),
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(tag ? { tags: { has: tag } } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { body: { contains: search, mode: Prisma.QueryMode.insensitive } },
            ],
          }
        : {}),
      ...(resourceType && resourceId
        ? { links: { some: { resourceType, resourceId } } }
        : {}),
      ...this.buildVisibilityFilter(context),
    };

    const [items, total] = await Promise.all([
      this.prisma.note.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          links: true,
          author: { select: { id: true, name: true, email: true } },
          branch: { select: { id: true, name: true } },
        },
        ...pagination,
      }),
      includeTotal ? this.prisma.note.count({ where }) : Promise.resolve(null),
    ]);

    return buildPaginatedResponse(
      items,
      pagination.take,
      typeof total === 'number' ? total : undefined,
    );
  }

  async getNote(businessId: string, noteId: string, context: ViewerContext) {
    const note = await this.prisma.note.findFirst({
      where: { id: noteId, businessId },
      include: {
        links: true,
        reminders: true,
        author: { select: { id: true, name: true, email: true } },
        branch: { select: { id: true, name: true } },
      },
    });
    if (!note) {
      return null;
    }
    const visibilityFilter = this.buildVisibilityFilter(context);
    if (
      !context.canManage &&
      !(await this.prisma.note.findFirst({
        where: { id: noteId, businessId, ...visibilityFilter },
        select: { id: true },
      }))
    ) {
      return null;
    }
    return note;
  }

  async createNote(
    businessId: string,
    userId: string,
    data: NoteCreateInput,
    context: ViewerContext,
  ) {
    if (!data.title?.trim() || !data.body?.trim()) {
      throw new BadRequestException('Title and body are required.');
    }
    const visibility = (data.visibility ?? 'BUSINESS') as any;
    if (visibility === 'BRANCH' && !data.branchId) {
      throw new BadRequestException(
        'Branch is required for branch-visible notes.',
      );
    }
    if (
      visibility === 'BRANCH' &&
      data.branchId &&
      context.branchScope.length > 0 &&
      !context.branchScope.includes(data.branchId) &&
      !context.canManage
    ) {
      throw new ForbiddenException('Branch scope restriction.');
    }

    const tags = this.normalizeTags(data.tags);
    const resolvedLinks = await this.resolveLinks(businessId, data.links);

    const created = await this.prisma.note.create({
      data: {
        businessId,
        authorId: userId,
        branchId: data.branchId ?? null,
        title: data.title.trim(),
        body: data.body.trim(),
        visibility,
        tags,
      },
    });

    if (resolvedLinks.length) {
      await this.prisma.noteLink.createMany({
        data: resolvedLinks.map((link) => ({
          noteId: created.id,
          businessId,
          resourceType: link.resourceType,
          resourceId: link.resourceId,
          resourceName: link.resourceName,
        })),
        skipDuplicates: true,
      });
    }

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'NOTE_CREATE',
      resourceType: 'Note',
      resourceId: created.id,
      outcome: 'SUCCESS',
      after: created as unknown as Record<string, unknown>,
    });

    return this.getNote(businessId, created.id, context);
  }

  async updateNote(
    businessId: string,
    userId: string,
    noteId: string,
    data: NoteUpdateInput,
    context: ViewerContext,
  ) {
    const existing = await this.prisma.note.findFirst({
      where: { id: noteId, businessId },
      include: { links: true },
    });
    if (!existing) {
      return null;
    }
    if (!context.canManage && existing.authorId !== userId) {
      throw new ForbiddenException('Not allowed to edit this note.');
    }

    if (data.visibility === 'BRANCH' && !data.branchId) {
      throw new BadRequestException(
        'Branch is required for branch-visible notes.',
      );
    }
    if (
      data.visibility === 'BRANCH' &&
      data.branchId &&
      context.branchScope.length > 0 &&
      !context.branchScope.includes(data.branchId) &&
      !context.canManage
    ) {
      throw new ForbiddenException('Branch scope restriction.');
    }

    const tags = data.tags ? this.normalizeTags(data.tags) : undefined;
    const resolvedLinks =
      data.links !== undefined
        ? await this.resolveLinks(businessId, data.links)
        : null;

    const updated = await this.prisma.note.update({
      where: { id: noteId },
      data: {
        title: data.title?.trim() ?? existing.title,
        body: data.body?.trim() ?? existing.body,
        visibility: (data.visibility ?? existing.visibility) as any,
        branchId:
          data.branchId === undefined
            ? existing.branchId
            : (data.branchId ?? null),
        status: (data.status ?? existing.status) as any,
        ...(tags ? { tags } : {}),
      },
    });

    if (resolvedLinks !== null) {
      await this.prisma.noteLink.deleteMany({
        where: { noteId, businessId },
      });
      if (resolvedLinks.length) {
        await this.prisma.noteLink.createMany({
          data: resolvedLinks.map((link) => ({
            noteId,
            businessId,
            resourceType: link.resourceType,
            resourceId: link.resourceId,
            resourceName: link.resourceName,
          })),
        });
      }
    }

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'NOTE_UPDATE',
      resourceType: 'Note',
      resourceId: updated.id,
      outcome: 'SUCCESS',
      before: existing as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });

    return this.getNote(businessId, noteId, context);
  }

  async archiveNote(
    businessId: string,
    userId: string,
    noteId: string,
    context: ViewerContext,
  ) {
    const existing = await this.prisma.note.findFirst({
      where: { id: noteId, businessId },
    });
    if (!existing) {
      return null;
    }
    if (!context.canManage && existing.authorId !== userId) {
      throw new ForbiddenException('Not allowed to archive this note.');
    }
    const updated = await this.prisma.note.update({
      where: { id: noteId },
      data: { status: 'ARCHIVED' },
    });
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'NOTE_ARCHIVE',
      resourceType: 'Note',
      resourceId: updated.id,
      outcome: 'SUCCESS',
      before: existing as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });
    return updated;
  }

  async listReminders(
    businessId: string,
    noteId: string,
    context: ViewerContext,
  ) {
    const note = await this.prisma.note.findFirst({
      where: { id: noteId, businessId },
    });
    if (!note) {
      return [];
    }
    if (!context.canManage && note.authorId !== context.userId) {
      throw new ForbiddenException('Not allowed to view reminders.');
    }
    return this.prisma.noteReminder.findMany({
      where: { noteId, businessId },
      orderBy: { scheduledAt: 'asc' },
    });
  }

  async listReminderOverview(
    businessId: string,
    context: ViewerContext,
    query: { limit?: string; windowDays?: string } = {},
  ) {
    const limit = Number(query.limit ?? 5);
    const windowDays = Number(query.windowDays ?? 7);
    const take = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 10)) : 5;
    const days = Number.isFinite(windowDays)
      ? Math.max(1, Math.min(windowDays, 30))
      : 7;
    const now = new Date();
    const upcomingEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const baseWhere: Prisma.NoteReminderWhereInput = {
      businessId,
      status: 'SCHEDULED',
      ...(context.branchScope?.length
        ? { branchId: { in: context.branchScope } }
        : {}),
    };
    if (!context.canManage) {
      baseWhere.OR = [
        { createdById: context.userId },
        { recipientId: context.userId },
      ];
    }
    const [upcoming, overdue, upcomingCount, overdueCount] =
      await Promise.all([
        this.prisma.noteReminder.findMany({
          where: {
            ...baseWhere,
            scheduledAt: { gte: now, lte: upcomingEnd },
          },
          orderBy: { scheduledAt: 'asc' },
          take,
          include: {
            note: { select: { id: true, title: true } },
            branch: { select: { id: true, name: true } },
          },
        }),
        this.prisma.noteReminder.findMany({
          where: { ...baseWhere, scheduledAt: { lt: now } },
          orderBy: { scheduledAt: 'desc' },
          take,
          include: {
            note: { select: { id: true, title: true } },
            branch: { select: { id: true, name: true } },
          },
        }),
        this.prisma.noteReminder.count({
          where: {
            ...baseWhere,
            scheduledAt: { gte: now, lte: upcomingEnd },
          },
        }),
        this.prisma.noteReminder.count({
          where: { ...baseWhere, scheduledAt: { lt: now } },
        }),
      ]);

    return {
      upcoming: { count: upcomingCount, items: upcoming },
      overdue: { count: overdueCount, items: overdue },
    };
  }

  async createReminders(
    businessId: string,
    noteId: string,
    userId: string,
    data: ReminderCreateInput,
  ) {
    const note = await this.prisma.note.findFirst({
      where: { id: noteId, businessId },
    });
    if (!note) {
      return null;
    }
    if (note.status !== 'ACTIVE') {
      throw new BadRequestException('Cannot add reminders to archived notes.');
    }
    const scheduledAt = new Date(data.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new BadRequestException('Invalid reminder date.');
    }

    const channels = Array.from(new Set(data.channels ?? []));
    if (!channels.length) {
      throw new BadRequestException(
        'At least one reminder channel is required.',
      );
    }

    for (const channel of channels) {
      await this.assertReminderChannel(businessId, channel);
    }

    const reminders = await this.prisma.noteReminder.createMany({
      data: channels.map((channel) => ({
        noteId,
        businessId,
        createdById: userId,
        recipientId: data.recipientId ?? note.authorId,
        branchId: data.branchId ?? note.branchId ?? null,
        scheduledAt,
        channel,
      })),
    });

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'NOTE_REMINDER_CREATE',
      resourceType: 'Note',
      resourceId: noteId,
      outcome: 'SUCCESS',
      metadata: { channels, scheduledAt: scheduledAt.toISOString() },
    });

    return reminders;
  }

  async cancelReminder(businessId: string, reminderId: string, userId: string) {
    const reminder = await this.prisma.noteReminder.findFirst({
      where: { id: reminderId, businessId },
      include: { note: true },
    });
    if (!reminder) {
      return null;
    }
    if (reminder.note.authorId !== userId) {
      throw new ForbiddenException('Not allowed to cancel this reminder.');
    }
    const updated = await this.prisma.noteReminder.update({
      where: { id: reminderId },
      data: { status: 'CANCELLED' },
    });
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'NOTE_REMINDER_CANCEL',
      resourceType: 'NoteReminder',
      resourceId: reminderId,
      outcome: 'SUCCESS',
    });
    return updated;
  }

  async listLinkables(
    businessId: string,
    type: string,
    query: string,
    branchScope: string[] = [],
  ) {
    const q = query.trim();
    if (!q) {
      return [];
    }
    switch (type) {
      case 'Product':
        return this.prisma.product.findMany({
          where: {
            businessId,
            name: { contains: q, mode: Prisma.QueryMode.insensitive },
          },
          select: { id: true, name: true },
          take: 20,
        });
      case 'Variant':
        return this.prisma.variant.findMany({
          where: {
            businessId,
            OR: [
              { name: { contains: q, mode: Prisma.QueryMode.insensitive } },
              { sku: { contains: q, mode: Prisma.QueryMode.insensitive } },
              { product: { name: { contains: q, mode: Prisma.QueryMode.insensitive } } },
            ],
          },
          select: { id: true, name: true, product: { select: { name: true } } },
          take: 20,
        });
      case 'Branch': {
        return this.prisma.branch.findMany({
          where: {
            businessId,
            name: { contains: q, mode: Prisma.QueryMode.insensitive },
            ...(branchScope.length ? { id: { in: branchScope } } : {}),
          },
          select: { id: true, name: true },
          take: 20,
        });
      }
      case 'Supplier':
        return this.prisma.supplier.findMany({
          where: {
            businessId,
            name: { contains: q, mode: Prisma.QueryMode.insensitive },
          },
          select: { id: true, name: true },
          take: 20,
        });
      case 'Customer':
        return this.prisma.customer.findMany({
          where: {
            businessId,
            name: { contains: q, mode: Prisma.QueryMode.insensitive },
          },
          select: { id: true, name: true },
          take: 20,
        });
      case 'PurchaseOrder':
        return this.prisma.purchaseOrder.findMany({
          where: {
            businessId,
            id: { contains: q, mode: Prisma.QueryMode.insensitive },
          },
          select: { id: true, status: true },
          take: 20,
        });
      case 'Purchase':
        return this.prisma.purchase.findMany({
          where: {
            businessId,
            id: { contains: q, mode: Prisma.QueryMode.insensitive },
          },
          select: { id: true, status: true, total: true },
          take: 20,
        });
      case 'Transfer': {
        const transferScopeFilter = branchScope.length
          ? {
              OR: [
                { sourceBranchId: { in: branchScope } },
                { destinationBranchId: { in: branchScope } },
              ],
            }
          : {};
        return this.prisma.transfer.findMany({
          where: {
            businessId,
            ...transferScopeFilter,
            id: { contains: q, mode: Prisma.QueryMode.insensitive },
          },
          select: {
            id: true,
            status: true,
            sourceBranch: { select: { name: true } },
            destinationBranch: { select: { name: true } },
          },
          take: 20,
        });
      }
      default:
        return [];
    }
  }

  async getMeta(businessId: string) {
    const subscription =
      await this.subscriptionService.getSubscription(businessId);
    if (!subscription) {
      return { tier: null, allowedChannels: [] };
    }
    return {
      tier: subscription.tier,
      allowedChannels: CHANNEL_RULES[subscription.tier] ?? [],
    };
  }
}
