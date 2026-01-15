import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuditService } from '../audit/audit.service';
import { labelWithFallback } from '../common/labels';
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

@Injectable()
export class ExpensesService {
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
    const status = query.status?.toLowerCase();
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    const branchFilter = this.resolveBranchScope(branchScope, query.branchId);
    const where = {
      businessId,
      ...branchFilter,
      ...(query.category ? { category: query.category as any } : {}),
      ...(status === 'transfer'
        ? { transferId: { not: null } }
        : status === 'direct'
          ? { transferId: null }
          : {}),
      ...(search
        ? {
            OR: [
              { note: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { receiptRef: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { branch: { name: { contains: search, mode: Prisma.QueryMode.insensitive } } },
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
          transfer: true,
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
      amount: number;
      currency?: string;
      expenseDate?: string;
      note?: string;
      receiptRef?: string;
    },
  ) {
    if (!data.branchId || !data.amount || data.amount <= 0) {
      return { error: 'Invalid expense amount.' };
    }
    const branch = await this.prisma.branch.findFirst({
      where: { id: data.branchId, businessId },
    });
    if (!branch) {
      return null;
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
        businessId,
        branchId: data.branchId,
        category: (data.category ?? 'GENERAL') as any,
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
