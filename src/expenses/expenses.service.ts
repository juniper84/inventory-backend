import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuditService } from '../audit/audit.service';
import { labelWithFallback } from '../common/labels';
import { generateReferenceNumber } from '../common/reference-number';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_APPROVAL_DEFAULTS,
  DEFAULT_LOCALE_SETTINGS,
} from '../settings/defaults';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';

type ApprovalDefaults = {
  expense?: boolean;
};

const SYSTEM_CATEGORIES = [
  { code: 'GENERAL', label: 'General' },
  { code: 'TRANSFER_FEE', label: 'Transfer Fee' },
  { code: 'SHIPPING', label: 'Shipping' },
  { code: 'UTILITIES', label: 'Utilities' },
  { code: 'RENT', label: 'Rent' },
  { code: 'PAYROLL', label: 'Payroll' },
  { code: 'STOCK_COST', label: 'Stock Cost' },
  { code: 'OTHER', label: 'Other' },
];

@Injectable()
export class ExpensesService {
  private readonly logger = new Logger(ExpensesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly approvalsService: ApprovalsService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private async getApprovalDefaults(
    businessId: string,
  ): Promise<ApprovalDefaults> {
    const settings = await this.prisma.businessSettings.findUnique({
      where: { businessId },
      select: { approvalDefaults: true },
    });
    const approvalDefaults =
      (settings?.approvalDefaults as Record<string, unknown> | null) ?? {};
    return {
      ...(DEFAULT_APPROVAL_DEFAULTS as ApprovalDefaults),
      ...approvalDefaults,
    };
  }

  private async getCurrency(businessId: string) {
    const settings = await this.prisma.businessSettings.findUnique({
      where: { businessId },
      select: { localeSettings: true },
    });
    const locale =
      (settings?.localeSettings as Record<string, unknown> | null) ?? {};
    return String(locale.currency ?? DEFAULT_LOCALE_SETTINGS.currency);
  }

  list(
    businessId: string,
    query: PaginationQuery & {
      search?: string;
      branchId?: string;
      category?: string;
      status?: string;
      from?: string;
      to?: string;
      includeTotal?: string;
    } = {},
    branchScope: string[] = [],
  ) {
    const pagination = parsePagination(query);
    const search = query.search?.trim();
    const VALID_STATUS_FILTERS = new Set(['transfer', 'direct', 'pending', 'approved', 'rejected']);
    const rawStatus = query.status?.toLowerCase();
    // P4-SW1-L5: Validate status filter — only known values are passed to Prisma.
    // Unknown values are silently ignored to avoid leaking schema details.
    const status = rawStatus && VALID_STATUS_FILTERS.has(rawStatus) ? rawStatus : undefined;
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    const branchFilter = this.resolveBranchScope(branchScope, query.branchId);
    const where = {
      businessId,
      ...branchFilter,
      ...(query.category ? { category: query.category } : {}),
      ...(status === 'transfer'
        ? { transferId: { not: null } }
        : status === 'direct'
          ? { transferId: null }
          : {}),
      ...(search
        ? {
            OR: [
              {
                note: { contains: search, mode: Prisma.QueryMode.insensitive },
              },
              {
                receiptRef: {
                  contains: search,
                  mode: Prisma.QueryMode.insensitive,
                },
              },
              {
                branch: {
                  name: {
                    contains: search,
                    mode: Prisma.QueryMode.insensitive,
                  },
                },
              },
            ],
          }
        : {}),
      ...(from || to
        ? {
            expenseDate: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };
    const includeTotal =
      query.includeTotal === 'true' || query.includeTotal === '1';
    return Promise.all([
      this.prisma.expense.findMany({
        where,
        include: {
          branch: true,
          transfer: {
            include: {
              sourceBranch: { select: { id: true, name: true } },
              destinationBranch: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        ...pagination,
      }),
      includeTotal
        ? this.prisma.expense.count({ where })
        : Promise.resolve(null),
    ]).then(([items, total]) =>
      buildPaginatedResponse(
        items,
        pagination.take,
        typeof total === 'number' ? total : undefined,
      ),
    );
  }

  async create(
    businessId: string,
    userId: string,
    roleIds: string[],
    data: {
      branchId: string;
      category?: string;
      title?: string;
      amount: number;
      currency?: string;
      expenseDate?: string;
      note?: string;
      receiptRef?: string;
    },
  ) {
    if (!data.branchId || !data.amount || data.amount <= 0) {
      throw new BadRequestException('Invalid expense amount.');
    }
    const branch = await this.prisma.branch.findFirst({
      where: { id: data.branchId, businessId },
    });
    if (!branch) {
      throw new NotFoundException('Branch not found.');
    }

    const defaults = await this.getApprovalDefaults(businessId);
    if (defaults.expense) {
      const approval = await this.approvalsService.requestApproval({
        businessId,
        actionType: 'EXPENSE_CREATE',
        requestedByUserId: userId,
        requesterRoleIds: roleIds,
        amount: Number(data.amount),
        reason: data.note,
        metadata: data,
        targetType: 'Expense',
        targetId: branch.id,
      });
      if (approval.required) {
        return { approvalRequired: true, approvalId: approval.approval?.id };
      }
    }

    const currency =
      data.currency?.trim().toUpperCase() ||
      (await this.getCurrency(businessId));
    const expenseDate = data.expenseDate
      ? new Date(data.expenseDate)
      : new Date();
    const expense = await this.prisma.expense.create({
      data: {
        referenceNumber: await generateReferenceNumber(this.prisma, 'expense', businessId),
        businessId,
        branchId: data.branchId,
        category: data.category ?? 'GENERAL',
        title: data.title ?? null,
        amount: new Prisma.Decimal(data.amount),
        currency,
        expenseDate,
        note: data.note ?? null,
        receiptRef: data.receiptRef ?? null,
        createdBy: userId,
      },
    });

    await this.auditService.logEvent({
      businessId,
      userId,
      branchId: data.branchId,
      action: 'EXPENSE_CREATE',
      resourceType: 'Expense',
      resourceId: expense.id,
      outcome: 'SUCCESS',
      reason: data.note ?? undefined,
      metadata: {
        branchId: data.branchId,
        category: data.category ?? 'GENERAL',
        amount: data.amount,
        currency,
      },
    });

    await this.notificationsService.notifyEvent({
      businessId,
      eventKey: 'expenseRecorded',
      actorUserId: userId,
      title: 'Expense recorded',
      message: `Expense ${labelWithFallback({ id: expense.id })} created.`,
      priority: 'INFO',
      metadata: { expenseId: expense.id },
      branchId: data.branchId,
    });

    return expense;
  }

  // ── Expense Category CRUD ──────────────────────────────────────────

  async listCategories(businessId: string) {
    await this.seedSystemCategories();
    return this.prisma.expenseCategoryConfig.findMany({
      where: {
        OR: [{ businessId: null }, { businessId }],
      },
      orderBy: [{ isSystem: 'desc' }, { code: 'asc' }],
    });
  }

  async createCategory(
    businessId: string,
    data: { code: string; label: string },
  ) {
    try {
      return await this.prisma.expenseCategoryConfig.create({
        data: {
          businessId,
          code: data.code,
          label: data.label,
          isSystem: false,
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ConflictException(
          `Category code "${data.code}" already exists.`,
        );
      }
      throw err;
    }
  }

  async deleteCategory(businessId: string, id: string) {
    const cat = await this.prisma.expenseCategoryConfig.findFirst({
      where: { id, businessId },
    });
    if (!cat) {
      throw new NotFoundException('Category not found.');
    }
    if (cat.isSystem) {
      throw new BadRequestException('Cannot delete a system category.');
    }
    await this.prisma.expenseCategoryConfig.delete({ where: { id } });
    return { deleted: true };
  }

  async updateCategory(
    businessId: string,
    id: string,
    data: { label?: string; code?: string },
  ) {
    const cat = await this.prisma.expenseCategoryConfig.findFirst({
      where: { id, businessId },
    });
    if (!cat) {
      throw new NotFoundException('Category not found.');
    }
    if (cat.isSystem) {
      throw new BadRequestException('System categories cannot be edited.');
    }

    const updateData: Record<string, unknown> = {};
    if (data.label !== undefined) {
      if (!data.label.trim()) {
        throw new BadRequestException('Category label is required.');
      }
      updateData.label = data.label.trim();
    }
    if (data.code !== undefined) {
      const code = data.code.trim().toUpperCase().replace(/\s+/g, '_');
      if (!code) {
        throw new BadRequestException('Category code is required.');
      }
      // Check for duplicate code
      const existing = await this.prisma.expenseCategoryConfig.findFirst({
        where: {
          id: { not: id },
          OR: [
            { businessId, code },
            { businessId: null, code },
          ],
        },
      });
      if (existing) {
        throw new ConflictException(`Category code "${code}" already exists.`);
      }
      updateData.code = code;
    }

    if (!Object.keys(updateData).length) {
      return cat;
    }

    return this.prisma.expenseCategoryConfig.update({
      where: { id },
      data: updateData,
    });
  }

  private async seedSystemCategories() {
    const count = await this.prisma.expenseCategoryConfig.count({
      where: { isSystem: true, businessId: null },
    });
    if (count > 0) return;

    this.logger.log('Seeding system expense categories...');
    await this.prisma.expenseCategoryConfig.createMany({
      data: SYSTEM_CATEGORIES.map((c) => ({
        ...c,
        isSystem: true,
        businessId: null,
      })),
      skipDuplicates: true,
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private resolveBranchScope(branchScope: string[], branchId?: string) {
    if (!branchScope.length) {
      return branchId ? { branchId } : {};
    }
    if (branchId) {
      if (!branchScope.includes(branchId)) {
        throw new ForbiddenException('Branch-scoped role restriction.');
      }
      return { branchId };
    }
    return { branchId: { in: branchScope } };
  }
}
