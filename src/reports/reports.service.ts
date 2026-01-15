import { ForbiddenException, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_STOCK_POLICIES } from '../settings/defaults';
import { formatVariantLabel } from '../common/labels';

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private toDayKey(date: Date) {
    return date.toISOString().slice(0, 10);
  }

  private async getCustomerLookup(businessId: string, ids: string[]) {
    if (!ids.length) {
      return new Map<
        string,
        { name: string; phone?: string | null; tin?: string | null }
      >();
    }
    const customers = await this.prisma.customer.findMany({
      where: { businessId, id: { in: ids } },
      select: { id: true, name: true, phone: true, tin: true },
    });
    return new Map(
      customers.map((customer) => [
        customer.id,
        { name: customer.name, phone: customer.phone, tin: customer.tin },
      ]),
    );
  }

  private async getVariantLookup(businessId: string, ids: string[]) {
    if (!ids.length) {
      return new Map<string, { name: string; productName: string | null }>();
    }
    const variants = await this.prisma.variant.findMany({
      where: { businessId, id: { in: ids } },
      select: { id: true, name: true, product: { select: { name: true } } },
    });
    return new Map(
      variants.map((variant) => [
        variant.id,
        { name: variant.name, productName: variant.product?.name ?? null },
      ]),
    );
  }

  private async getBranchLookup(businessId: string, ids: string[]) {
    if (!ids.length) {
      return new Map<string, { name: string }>();
    }
    const branches = await this.prisma.branch.findMany({
      where: { businessId, id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(
      branches.map((branch) => [branch.id, { name: branch.name }]),
    );
  }

  private async getUserLookup(businessId: string, ids: string[]) {
    if (!ids.length) {
      return new Map<string, { name: string | null; email: string | null }>();
    }
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids }, memberships: { some: { businessId } } },
      select: { id: true, name: true, email: true },
    });
    return new Map(
      users.map((user) => [user.id, { name: user.name, email: user.email }]),
    );
  }

  private async getStockPolicies(businessId: string) {
    const settings = await this.prisma.businessSettings.findUnique({
      where: { businessId },
    });
    const stockPolicies =
      (settings?.stockPolicies as Record<string, unknown> | null) ?? {};
    return {
      ...DEFAULT_STOCK_POLICIES,
      ...stockPolicies,
    } as { expiryAlertDays?: number };
  }

  async stockReport(
    businessId: string,
    userId: string,
    filters?: { branchId?: string },
    branchScope: string[] = [],
  ) {
    const branchFilter = this.resolveBranchScope(
      branchScope,
      filters?.branchId,
    );
    const data = await this.prisma.stockSnapshot.findMany({
      where: {
        businessId,
        ...branchFilter,
      },
      include: {
        variant: { select: { name: true, product: { select: { name: true } } } },
        branch: { select: { name: true } },
      },
    });
    await this.auditService.logEvent({
      businessId,
      userId,
      branchId: filters?.branchId,
      action: 'REPORT_STOCK',
      resourceType: 'Report',
      outcome: 'SUCCESS',
      metadata: { resourceName: 'Stock report' },
    });
    return data.map((row) => ({
      ...row,
      variantName: row.variant?.name ?? null,
      productName: row.variant?.product?.name ?? null,
      branchName: row.branch?.name ?? null,
    }));
  }

  async salesReport(
    businessId: string,
    userId: string,
    filters?: { startDate?: string; endDate?: string; branchId?: string },
    branchScope: string[] = [],
  ) {
    const dateFilter = this.buildDateFilter(
      filters?.startDate,
      filters?.endDate,
    );
    const branchFilter = this.resolveBranchScope(
      branchScope,
      filters?.branchId,
    );
    const data = await this.prisma.sale.findMany({
      where: {
        businessId,
        ...branchFilter,
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      },
    });
    await this.auditService.logEvent({
      businessId,
      userId,
      branchId: filters?.branchId,
      action: 'REPORT_SALES',
      resourceType: 'Report',
      outcome: 'SUCCESS',
      metadata: { resourceName: 'Sales report' },
    });
    return data;
  }

  async vatReport(
    businessId: string,
    userId: string,
    filters?: { startDate?: string; endDate?: string; branchId?: string },
    branchScope: string[] = [],
  ) {
    const dateFilter = this.buildDateFilter(
      filters?.startDate,
      filters?.endDate,
    );
    const branchFilter = this.resolveBranchScope(
      branchScope,
      filters?.branchId,
    );
    const data = await this.prisma.saleLine.findMany({
      where: {
        sale: {
          businessId,
          ...branchFilter,
          ...(dateFilter ? { createdAt: dateFilter } : {}),
        },
      },
    });
    await this.auditService.logEvent({
      businessId,
      userId,
      branchId: filters?.branchId,
      action: 'REPORT_VAT',
      resourceType: 'Report',
      outcome: 'SUCCESS',
      metadata: { resourceName: 'VAT report' },
    });
    return data;
  }

  async vatSummaryReport(
    businessId: string,
    userId: string,
    filters?: { startDate?: string; endDate?: string; branchId?: string },
    branchScope: string[] = [],
  ) {
    const dateFilter = this.buildDateFilter(
      filters?.startDate,
      filters?.endDate,
    );
    const branchFilter = this.resolveBranchScope(
      branchScope,
      filters?.branchId,
    );
    const lines = await this.prisma.saleLine.findMany({
      where: {
        sale: {
          businessId,
          ...branchFilter,
          ...(dateFilter ? { createdAt: dateFilter } : {}),
        },
      },
      select: {
        vatAmount: true,
        vatRate: true,
        sale: { select: { createdAt: true } },
      },
    });
    const byRate = new Map<number, number>();
    const byDay = new Map<string, number>();
    let totalVat = 0;
    lines.forEach((line) => {
      const rate = Number(line.vatRate ?? 0);
      const amount = Number(line.vatAmount ?? 0);
      totalVat += amount;
      byRate.set(rate, (byRate.get(rate) ?? 0) + amount);
      const dayKey = this.toDayKey(line.sale.createdAt);
      byDay.set(dayKey, (byDay.get(dayKey) ?? 0) + amount);
    });
    await this.auditService.logEvent({
      businessId,
      userId,
      branchId: filters?.branchId,
      action: 'REPORT_VAT_SUMMARY',
      resourceType: 'Report',
      outcome: 'SUCCESS',
      metadata: { resourceName: 'VAT summary report' },
    });
    return {
      totalVat,
      byRate: Array.from(byRate.entries()).map(([vatRate, vatAmount]) => ({
        vatRate,
        vatAmount,
      })),
      byDay: Array.from(byDay.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, vatAmount]) => ({ date, vatAmount })),
    };
  }

  async pnlReport(
    businessId: string,
    userId: string,
    filters?: { startDate?: string; endDate?: string; branchId?: string },
    branchScope: string[] = [],
  ) {
    const dateFilter = this.buildDateFilter(
      filters?.startDate,
      filters?.endDate,
    );
    const branchFilter = this.resolveBranchScope(
      branchScope,
      filters?.branchId,
    );
    const data = await this.prisma.saleLine.findMany({
      where: {
        sale: {
          businessId,
          ...branchFilter,
          ...(dateFilter ? { createdAt: dateFilter } : {}),
        },
      },
      include: { variant: true, sale: { select: { createdAt: true } } },
    });
    const totals = data.reduce(
      (acc, line) => {
        const revenue = Number(line.lineTotal);
        const unitCost =
          line.unitCost !== null && line.unitCost !== undefined
            ? Number(line.unitCost)
            : Number(line.variant.defaultCost ?? 0);
        const cost = unitCost * Number(line.quantity);
        acc.revenue += revenue;
        acc.cost += cost;
        acc.grossProfit += revenue - cost;
        return acc;
      },
      { revenue: 0, cost: 0, grossProfit: 0 },
    );

    const byDayMap = new Map<
      string,
      {
        revenue: number;
        cost: number;
        grossProfit: number;
        losses: number;
        expenses: number;
        transferFees: number;
        netProfit: number;
      }
    >();
    const ensureDay = (day: string) => {
      if (!byDayMap.has(day)) {
        byDayMap.set(day, {
          revenue: 0,
          cost: 0,
          grossProfit: 0,
          losses: 0,
          expenses: 0,
          transferFees: 0,
          netProfit: 0,
        });
      }
      return byDayMap.get(day)!;
    };
    data.forEach((line) => {
      const dayKey = this.toDayKey(line.sale.createdAt);
      const bucket = ensureDay(dayKey);
      const revenue = Number(line.lineTotal);
      const unitCost =
        line.unitCost !== null && line.unitCost !== undefined
          ? Number(line.unitCost)
          : Number(line.variant.defaultCost ?? 0);
      const cost = unitCost * Number(line.quantity);
      bucket.revenue += revenue;
      bucket.cost += cost;
      bucket.grossProfit += revenue - cost;
    });

    const lossTotals = await this.prisma.lossEntry.aggregate({
      where: {
        businessId,
        ...branchFilter,
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      },
      _sum: { totalCost: true },
    });

    const lossEntries = await this.prisma.lossEntry.findMany({
      where: {
        businessId,
        ...branchFilter,
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      },
      select: { totalCost: true, createdAt: true },
    });
    lossEntries.forEach((entry) => {
      const dayKey = this.toDayKey(entry.createdAt);
      const bucket = ensureDay(dayKey);
      bucket.losses += Number(entry.totalCost ?? 0);
    });

    const expenseTotals = await this.prisma.expense.aggregate({
      where: {
        businessId,
        category: { not: 'TRANSFER_FEE' },
        ...branchFilter,
        ...(dateFilter ? { expenseDate: dateFilter } : {}),
      },
      _sum: { amount: true },
    });

    const transferFeeTotals = await this.prisma.expense.aggregate({
      where: {
        businessId,
        category: 'TRANSFER_FEE',
        ...branchFilter,
        ...(dateFilter ? { expenseDate: dateFilter } : {}),
      },
      _sum: { amount: true },
    });

    const expenseEntries = await this.prisma.expense.findMany({
      where: {
        businessId,
        ...branchFilter,
        ...(dateFilter ? { expenseDate: dateFilter } : {}),
      },
      select: { amount: true, category: true, expenseDate: true },
    });
    expenseEntries.forEach((entry) => {
      const dayKey = this.toDayKey(entry.expenseDate);
      const bucket = ensureDay(dayKey);
      const amount = Number(entry.amount ?? 0);
      if (entry.category === 'TRANSFER_FEE') {
        bucket.transferFees += amount;
      } else {
        bucket.expenses += amount;
      }
    });

    byDayMap.forEach((bucket) => {
      bucket.netProfit =
        bucket.grossProfit - bucket.losses - bucket.expenses - bucket.transferFees;
    });

    const losses = Number(lossTotals._sum.totalCost ?? 0);
    const expenses = Number(expenseTotals._sum.amount ?? 0);
    const transferFees = Number(transferFeeTotals._sum.amount ?? 0);
    const netProfit = totals.grossProfit - losses - expenses - transferFees;
    await this.auditService.logEvent({
      businessId,
      userId,
      branchId: filters?.branchId,
      action: 'REPORT_PNL',
      resourceType: 'Report',
      outcome: 'SUCCESS',
      metadata: { resourceName: 'P&L report' },
    });
    return {
      lines: data,
      byDay: Array.from(byDayMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, totals]) => ({ date, ...totals })),
      totals: {
        ...totals,
        losses,
        expenses,
        transferFees,
        netProfit,
      },
    };
  }

  async customerSalesReport(
    businessId: string,
    userId: string,
    filters?: { startDate?: string; endDate?: string; branchId?: string },
    branchScope: string[] = [],
  ) {
    const dateFilter = this.buildDateFilter(
      filters?.startDate,
      filters?.endDate,
    );
    const branchFilter = this.resolveBranchScope(
      branchScope,
      filters?.branchId,
    );
    const data = await this.prisma.sale.groupBy({
      by: ['customerId'],
      where: {
        businessId,
        status: 'COMPLETED',
        ...branchFilter,
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      },
      _sum: { total: true },
      _count: { id: true },
    });
    const customerIds = data
      .map((row) => row.customerId)
      .filter((id): id is string => Boolean(id));
    const customerLookup = await this.getCustomerLookup(
      businessId,
      customerIds,
    );
    const enriched = data.map((row) => ({
      customerId: row.customerId,
      customerName: row.customerId
        ? (customerLookup.get(row.customerId)?.name ?? null)
        : null,
      total: row._sum.total ?? 0,
      count: row._count.id ?? 0,
    }));
    await this.auditService.logEvent({
      businessId,
      userId,
      branchId: filters?.branchId,
      action: 'REPORT_CUSTOMER_SALES',
      resourceType: 'Report',
      outcome: 'SUCCESS',
      metadata: { resourceName: 'Customer sales report' },
    });
    return enriched;
  }

  async customerRefundsReport(
    businessId: string,
    userId: string,
    filters?: { startDate?: string; endDate?: string; branchId?: string },
    branchScope: string[] = [],
  ) {
    const dateFilter = this.buildDateFilter(
      filters?.startDate,
      filters?.endDate,
    );
    const branchFilter = this.resolveBranchScope(
      branchScope,
      filters?.branchId,
    );
    const data = await this.prisma.saleRefund.groupBy({
      by: ['customerId'],
      where: {
        businessId,
        status: 'COMPLETED',
        ...branchFilter,
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      },
      _sum: { total: true },
      _count: { id: true },
    });
    const customerIds = data
      .map((row) => row.customerId)
      .filter((id): id is string => Boolean(id));
    const customerLookup = await this.getCustomerLookup(
      businessId,
      customerIds,
    );
    const enriched = data.map((row) => ({
      customerId: row.customerId,
      customerName: row.customerId
        ? (customerLookup.get(row.customerId)?.name ?? null)
        : null,
      total: row._sum.total ?? 0,
      count: row._count.id ?? 0,
    }));
    await this.auditService.logEvent({
      businessId,
      userId,
      branchId: filters?.branchId,
      action: 'REPORT_CUSTOMER_REFUNDS',
      resourceType: 'Report',
      outcome: 'SUCCESS',
      metadata: { resourceName: 'Customer refunds report' },
    });
    return enriched;
  }

  async customerOutstandingReport(
    businessId: string,
    userId: string,
    filters?: { branchId?: string },
    branchScope: string[] = [],
  ) {
    const branchFilter = this.resolveBranchScope(
      branchScope,
      filters?.branchId,
    );
    const data = await this.prisma.sale.findMany({
      where: {
        businessId,
        outstandingAmount: { gt: 0 },
        customerId: { not: null },
        ...branchFilter,
      },
      select: {
        id: true,
        customerId: true,
        customerNameSnapshot: true,
        outstandingAmount: true,
        creditDueDate: true,
      },
      orderBy: { outstandingAmount: 'desc' },
    });
    await this.auditService.logEvent({
      businessId,
      userId,
      branchId: filters?.branchId,
      action: 'REPORT_CUSTOMER_OUTSTANDING',
      resourceType: 'Report',
      outcome: 'SUCCESS',
      metadata: { resourceName: 'Customer outstanding report' },
    });
    return data;
  }

  async topCustomersReport(
    businessId: string,
    userId: string,
    filters?: { branchId?: string },
    branchScope: string[] = [],
  ) {
    const branchFilter = this.resolveBranchScope(
      branchScope,
      filters?.branchId,
    );
    const data = await this.prisma.sale.groupBy({
      by: ['customerId'],
      where: {
        businessId,
        status: 'COMPLETED',
        customerId: { not: null },
        ...branchFilter,
      },
      _sum: { total: true },
      _count: { id: true },
      orderBy: { _sum: { total: 'desc' } },
      take: 10,
    });
    const customerIds = data
      .map((row) => row.customerId)
      .filter((id): id is string => Boolean(id));
    const customerLookup = await this.getCustomerLookup(
      businessId,
      customerIds,
    );
    const enriched = data.map((row) => ({
      customerId: row.customerId,
      customerName: row.customerId
        ? (customerLookup.get(row.customerId)?.name ?? null)
        : null,
      total: row._sum.total ?? 0,
      count: row._count.id ?? 0,
    }));
    await this.auditService.logEvent({
      businessId,
      userId,
      branchId: filters?.branchId,
      action: 'REPORT_CUSTOMER_TOP',
      resourceType: 'Report',
      outcome: 'SUCCESS',
      metadata: { resourceName: 'Top customers report' },
    });
    return enriched;
  }

  async customerReportsCsv(
    businessId: string,
    userId: string,
    filters?: { startDate?: string; endDate?: string; branchId?: string },
    branchScope: string[] = [],
  ) {
    const sales = await this.customerSalesReport(
      businessId,
      userId,
      filters,
      branchScope,
    );
    const header = ['customerId', 'customerName', 'saleCount', 'salesTotal'];
    const rows = sales.map((row) => [
      row.customerId ?? '',
      row.customerName ?? '',
      String(row.count ?? 0),
      String(row.total ?? 0),
    ]);
    await this.auditService.logEvent({
      businessId,
      userId,
      branchId: filters?.branchId,
      action: 'EXPORT_CUSTOMER_REPORTS',
      resourceType: 'Export',
      outcome: 'SUCCESS',
      metadata: { resourceName: 'Customer reports export' },
    });
    return [header.join(','), ...rows.map((row) => row.join(','))].join('\n');
  }

  async lowStockReport(
    businessId: string,
    userId: string,
    filters?: { threshold?: string; branchId?: string },
    branchScope: string[] = [],
  ) {
    const threshold = filters?.threshold ? Number(filters.threshold) : 5;
    const branchFilter = this.resolveBranchScope(
      branchScope,
      filters?.branchId,
    );
    const data = await this.prisma.stockSnapshot.findMany({
      where: { businessId, quantity: { lte: threshold }, ...branchFilter },
      include: {
        variant: { include: { product: { select: { name: true } } } },
        branch: true,
      },
    });
    await this.auditService.logEvent({
      businessId,
      userId,
      branchId: filters?.branchId,
      action: 'REPORT_LOW_STOCK',
      resourceType: 'Report',
      outcome: 'SUCCESS',
      metadata: { resourceName: 'Low stock report' },
    });
    return data;
  }

  async expiryReport(
    businessId: string,
    userId: string,
    filters?: { days?: string; branchId?: string },
    branchScope: string[] = [],
  ) {
    const stockPolicies = await this.getStockPolicies(businessId);
    const days =
      filters?.days !== undefined
        ? Number(filters.days)
        : (stockPolicies.expiryAlertDays ?? 30);
    const branchFilter = this.resolveBranchScope(
      branchScope,
      filters?.branchId,
    );
    const cutoff = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const data = await this.prisma.batch.findMany({
      where: {
        businessId,
        expiryDate: { lte: cutoff },
        ...branchFilter,
      },
      include: {
        variant: { include: { product: { select: { name: true } } } },
        branch: true,
      },
      orderBy: { expiryDate: 'asc' },
    });
    const notifyExpiry = await this.notificationsService.isEventEnabled(
      businessId,
      'expiry',
    );
    if (notifyExpiry) {
      await Promise.all(
        data.map(async (batch) => {
          if (!batch.expiryDate) {
            return;
          }
          const existing = await this.prisma.notification.findFirst({
            where: {
              businessId,
              title: 'Batch expiring',
              metadata: {
                path: ['batchId'],
                equals: batch.id,
              },
            },
          });
          if (existing) {
            return;
          }
          const variantLabel = formatVariantLabel({
            id: batch.variantId,
            name: batch.variant?.name ?? null,
            productName: batch.variant?.product?.name ?? null,
          });
          await this.notificationsService.notifyEvent({
            businessId,
            eventKey: 'expiry',
            title: 'Batch expiring',
            message: `${variantLabel} batch ${batch.code} expires on ${batch.expiryDate.toISOString().slice(0, 10)}.`,
            priority: 'WARNING',
            metadata: {
              batchId: batch.id,
              variantId: batch.variantId,
              ...(batch.variant?.product?.name
                ? { productName: batch.variant.product.name }
                : {}),
              branchId: batch.branchId,
              expiryDate: batch.expiryDate.toISOString(),
            },
            branchId: batch.branchId,
          });
        }),
      );
    }
    await this.auditService.logEvent({
      businessId,
      userId,
      branchId: filters?.branchId,
      action: 'REPORT_EXPIRY',
      resourceType: 'Report',
      outcome: 'SUCCESS',
      metadata: { resourceName: 'Expiry report' },
    });
    return data;
  }

  async stockCountVarianceReport(
    businessId: string,
    userId: string,
    filters?: { from?: string; to?: string; branchId?: string },
    branchScope: string[] = [],
  ) {
    const dateFilter = this.buildDateFilter(filters?.from, filters?.to);
    const branchFilter = this.resolveBranchScope(
      branchScope,
      filters?.branchId,
    );
    const logs = await this.prisma.auditLog.findMany({
      where: {
        businessId,
        action: 'STOCK_COUNT',
        ...branchFilter,
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    const variantIds = logs
      .map((log) => (log.metadata as { variantId?: string } | null)?.variantId)
      .filter((id): id is string => Boolean(id));
    const branchIds = logs
      .map((log) => log.branchId)
      .filter((id): id is string => Boolean(id));
    const [variantLookup, branchLookup] = await Promise.all([
      this.getVariantLookup(businessId, variantIds),
      this.getBranchLookup(businessId, branchIds),
    ]);

    const rows = logs.map((log) => {
      const meta =
        (log.metadata as {
          variantId?: string;
          countedQuantity?: number;
          expectedQuantity?: number;
          variance?: number;
          reason?: string;
        } | null) ?? {};
      const variantName = meta.variantId
        ? (variantLookup.get(meta.variantId)?.name ?? null)
        : null;
      const productName = meta.variantId
        ? (variantLookup.get(meta.variantId)?.productName ?? null)
        : null;
      const branchName = log.branchId
        ? (branchLookup.get(log.branchId)?.name ?? null)
        : null;
      return {
        id: log.id,
        branchId: log.branchId,
        branchName,
        variantId: meta.variantId ?? null,
        variantName,
        productName,
        countedQuantity: meta.countedQuantity ?? null,
        expectedQuantity: meta.expectedQuantity ?? null,
        variance: meta.variance ?? null,
        reason: log.reason ?? null,
        createdAt: log.createdAt,
        userId: log.userId ?? null,
      };
    });

    await this.auditService.logEvent({
      businessId,
      userId,
      branchId: filters?.branchId,
      action: 'REPORT_STOCK_COUNT_VARIANCE',
      resourceType: 'Report',
      outcome: 'SUCCESS',
      metadata: { resourceName: 'Stock count variance report' },
    });

    return rows;
  }

  async staffPerformance(
    businessId: string,
    userId: string,
    filters?: { startDate?: string; endDate?: string; branchId?: string },
    branchScope: string[] = [],
  ) {
    const dateFilter = this.buildDateFilter(
      filters?.startDate,
      filters?.endDate,
    );
    const branchFilter = this.resolveBranchScope(
      branchScope,
      filters?.branchId,
    );
    const data = await this.prisma.sale.groupBy({
      by: ['cashierId'],
      where: {
        businessId,
        status: 'COMPLETED',
        cashierId: { not: null },
        ...branchFilter,
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      },
      _sum: { total: true },
      _count: { id: true },
      orderBy: { _sum: { total: 'desc' } },
    });
    const cashierIds = data
      .map((row) => row.cashierId)
      .filter((id): id is string => Boolean(id));
    const userLookup = await this.getUserLookup(businessId, cashierIds);
    await this.auditService.logEvent({
      businessId,
      userId,
      branchId: filters?.branchId,
      action: 'REPORT_STAFF_PERFORMANCE',
      resourceType: 'Report',
      outcome: 'SUCCESS',
      metadata: { resourceName: 'Staff performance report' },
    });
    return data.map((row) => ({
      ...row,
      cashierName: row.cashierId
        ? (userLookup.get(row.cashierId)?.name ??
          userLookup.get(row.cashierId)?.email ??
          null)
        : null,
    }));
  }

  async topLossesReport(
    businessId: string,
    userId: string,
    filters?: { days?: string; limit?: string; branchId?: string },
    branchScope: string[] = [],
  ) {
    const days = Number(filters?.days ?? 30);
    const limit = Number(filters?.limit ?? 5);
    const safeDays = Number.isFinite(days) ? Math.max(1, Math.min(days, 90)) : 30;
    const take = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 10)) : 5;
    const startDate = new Date(
      Date.now() - safeDays * 24 * 60 * 60 * 1000,
    );
    const branchFilter = this.resolveBranchScope(
      branchScope,
      filters?.branchId,
    );
    const grouped = await this.prisma.lossEntry.groupBy({
      by: ['variantId'],
      where: {
        businessId,
        ...branchFilter,
        createdAt: { gte: startDate },
      },
      _sum: { totalCost: true, quantity: true },
      _count: { id: true },
      orderBy: { _sum: { totalCost: 'desc' } },
      take,
    });
    const variantIds = grouped.map((row) => row.variantId);
    const variants = await this.prisma.variant.findMany({
      where: { businessId, id: { in: variantIds } },
      select: {
        id: true,
        name: true,
        sku: true,
        product: { select: { name: true } },
      },
    });
    const variantLookup = new Map(variants.map((variant) => [variant.id, variant]));
    await this.auditService.logEvent({
      businessId,
      userId,
      branchId: filters?.branchId,
      action: 'REPORT_TOP_LOSSES',
      resourceType: 'Report',
      outcome: 'SUCCESS',
      metadata: { resourceName: 'Top losses report', days: safeDays },
    });
    return {
      days: safeDays,
      items: grouped.map((row) => {
        const variant = variantLookup.get(row.variantId);
        return {
          variantId: row.variantId,
          variantName: variant?.name ?? null,
          productName: variant?.product?.name ?? null,
          sku: variant?.sku ?? null,
          lossCount: row._count.id,
          totalCost: Number(row._sum.totalCost ?? 0),
          quantity: Number(row._sum.quantity ?? 0),
        };
      }),
    };
  }

  private buildDateFilter(start?: string, end?: string) {
    if (!start && !end) {
      return null;
    }
    const filter: { gte?: Date; lte?: Date } = {};
    if (start) {
      filter.gte = new Date(start);
    }
    if (end) {
      filter.lte = new Date(end);
    }
    return filter;
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
