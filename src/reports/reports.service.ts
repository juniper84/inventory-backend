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
        variant: {
          select: { name: true, product: { select: { name: true } } },
        },
        branch: { select: { name: true } },
      },
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
        refunds: number;
        losses: number;
        adjustmentGains: number;
        stockCountShortages: number;
        stockCountSurpluses: number;
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
          refunds: 0,
          losses: 0,
          adjustmentGains: 0,
          stockCountShortages: 0,
          stockCountSurpluses: 0,
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

    // Refunds: subtract refunded revenue and reverse refunded cost
    const refundLines = await this.prisma.saleRefundLine.findMany({
      where: {
        refund: {
          businessId,
          status: 'COMPLETED',
          ...branchFilter,
          ...(dateFilter ? { createdAt: dateFilter } : {}),
        },
      },
      include: {
        variant: { select: { defaultCost: true } },
        refund: { select: { createdAt: true } },
      },
    });
    const refundTotals = refundLines.reduce(
      (acc, line) => {
        const refundRevenue = Number(line.lineTotal);
        const unitCost = Number(line.variant.defaultCost ?? 0);
        const refundCost = unitCost * Number(line.quantity);
        acc.revenue += refundRevenue;
        acc.cost += refundCost;
        return acc;
      },
      { revenue: 0, cost: 0 },
    );
    totals.revenue -= refundTotals.revenue;
    totals.cost -= refundTotals.cost;
    totals.grossProfit = totals.revenue - totals.cost;

    refundLines.forEach((line) => {
      const dayKey = this.toDayKey(line.refund.createdAt);
      const bucket = ensureDay(dayKey);
      const refundRevenue = Number(line.lineTotal);
      const unitCost = Number(line.variant.defaultCost ?? 0);
      const refundCost = unitCost * Number(line.quantity);
      bucket.refunds += refundRevenue;
      bucket.revenue -= refundRevenue;
      bucket.cost -= refundCost;
      bucket.grossProfit = bucket.revenue - bucket.cost;
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

    // Gain entries from positive stock adjustments
    const gainTotals = await this.prisma.gainEntry.aggregate({
      where: {
        businessId,
        ...branchFilter,
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      },
      _sum: { totalCost: true },
    });

    const gainEntries = await this.prisma.gainEntry.findMany({
      where: {
        businessId,
        ...branchFilter,
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      },
      select: { totalCost: true, createdAt: true },
    });
    gainEntries.forEach((entry) => {
      const dayKey = this.toDayKey(entry.createdAt);
      const bucket = ensureDay(dayKey);
      bucket.adjustmentGains += Number(entry.totalCost ?? 0);
    });

    // Stock count variance costs (shortages and surpluses)
    const varianceCostEntries = await this.prisma.stockCountVarianceCost.findMany({
      where: {
        businessId,
        ...branchFilter,
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      },
      select: { totalCost: true, varianceType: true, createdAt: true },
    });

    let stockCountShortagesTotal = 0;
    let stockCountSurplusesTotal = 0;
    varianceCostEntries.forEach((entry) => {
      const dayKey = this.toDayKey(entry.createdAt);
      const bucket = ensureDay(dayKey);
      const cost = Number(entry.totalCost ?? 0);
      if (entry.varianceType === 'SHORTAGE') {
        stockCountShortagesTotal += cost;
        bucket.stockCountShortages += cost;
      } else {
        stockCountSurplusesTotal += cost;
        bucket.stockCountSurpluses += cost;
      }
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
        bucket.grossProfit -
        bucket.losses -
        bucket.stockCountShortages +
        bucket.adjustmentGains +
        bucket.stockCountSurpluses -
        bucket.expenses -
        bucket.transferFees;
    });

    const refunds = refundTotals.revenue;
    const losses = Number(lossTotals._sum.totalCost ?? 0);
    const adjustmentGains = Number(gainTotals._sum.totalCost ?? 0);
    const expenses = Number(expenseTotals._sum.amount ?? 0);
    const transferFees = Number(transferFeeTotals._sum.amount ?? 0);
    const netProfit =
      totals.grossProfit -
      losses -
      stockCountShortagesTotal +
      adjustmentGains +
      stockCountSurplusesTotal -
      expenses -
      transferFees;
    return {
      lines: data,
      byDay: Array.from(byDayMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, totals]) => ({ date, ...totals })),
      totals: {
        ...totals,
        refunds,
        losses,
        adjustmentGains,
        stockCountShortages: stockCountShortagesTotal,
        stockCountSurpluses: stockCountSurplusesTotal,
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
      orderBy: { _sum: { total: 'desc' } },
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

    // Fetch variance cost records for financial data
    const movementIds = logs
      .map((log) => log.resourceId)
      .filter((id): id is string => Boolean(id));
    const varianceCosts = movementIds.length
      ? await this.prisma.stockCountVarianceCost.findMany({
          where: { stockMovementId: { in: movementIds } },
          select: {
            stockMovementId: true,
            unitCost: true,
            totalCost: true,
            varianceType: true,
          },
        })
      : [];
    const varianceCostMap = new Map(
      varianceCosts.map((vc) => [vc.stockMovementId, vc]),
    );

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
      const costRecord = log.resourceId
        ? varianceCostMap.get(log.resourceId) ?? null
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
        unitCost: costRecord ? Number(costRecord.unitCost) : null,
        totalCost: costRecord ? Number(costRecord.totalCost) : null,
        varianceType: costRecord?.varianceType ?? null,
      };
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
    const safeDays = Number.isFinite(days)
      ? Math.max(1, Math.min(days, 90))
      : 30;
    const take = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 10)) : 5;
    const startDate = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
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
    const variantLookup = new Map(
      variants.map((variant) => [variant.id, variant]),
    );
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

  async topProductsReport(
    businessId: string,
    userId: string,
    filters?: {
      startDate?: string;
      endDate?: string;
      branchId?: string;
      limit?: string;
    },
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
    const limit = Number(filters?.limit ?? 5);
    const take = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 10)) : 5;

    const grouped = await this.prisma.saleLine.groupBy({
      by: ['variantId'],
      where: {
        sale: {
          businessId,
          status: 'COMPLETED',
          ...branchFilter,
          ...(dateFilter ? { createdAt: dateFilter } : {}),
        },
      },
      _sum: { lineTotal: true, quantity: true },
      _count: { id: true },
      orderBy: { _sum: { lineTotal: 'desc' } },
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

    return {
      items: grouped.map((row) => {
        const variant = variantLookup.get(row.variantId);
        return {
          variantId: row.variantId,
          variantName: variant?.name ?? null,
          productName: variant?.product?.name ?? null,
          sku: variant?.sku ?? null,
          totalRevenue: Number(row._sum.lineTotal ?? 0),
          quantity: Number(row._sum.quantity ?? 0),
          saleLineCount: row._count.id,
        };
      }),
    };
  }

  async salesByBranchReport(
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

    const grouped = await this.prisma.sale.groupBy({
      by: ['branchId'],
      where: {
        businessId,
        status: 'COMPLETED',
        ...branchFilter,
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      },
      _sum: { total: true },
      _count: { id: true },
      orderBy: { _sum: { total: 'desc' } },
    });

    const branchLookup = await this.getBranchLookup(
      businessId,
      grouped.map((row) => row.branchId),
    );
    const total = grouped.reduce(
      (sum, row) => sum + Number(row._sum.total ?? 0),
      0,
    );

    return {
      total,
      items: grouped.map((row) => ({
        branchId: row.branchId,
        branchName: branchLookup.get(row.branchId)?.name ?? null,
        totalSales: Number(row._sum.total ?? 0),
        saleCount: row._count.id,
      })),
    };
  }

  async expenseBreakdownReport(
    businessId: string,
    userId: string,
    filters?: {
      startDate?: string;
      endDate?: string;
      branchId?: string;
      limit?: string;
    },
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
    const limit = Number(filters?.limit ?? 8);
    const take = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 20)) : 8;

    const grouped = await this.prisma.expense.groupBy({
      by: ['category'],
      where: {
        businessId,
        ...branchFilter,
        ...(dateFilter ? { expenseDate: dateFilter } : {}),
      },
      _sum: { amount: true },
      _count: { id: true },
      orderBy: { _sum: { amount: 'desc' } },
      take,
    });

    const total = grouped.reduce(
      (sum, row) => sum + Number(row._sum.amount ?? 0),
      0,
    );

    return {
      total,
      items: grouped.map((row) => {
        const amount = Number(row._sum.amount ?? 0);
        return {
          category: row.category,
          amount,
          count: row._count.id,
          percent: total > 0 ? (amount / total) * 100 : 0,
        };
      }),
    };
  }

  async recentActivityReport(
    businessId: string,
    userId: string,
    filters?: { branchId?: string; limit?: string },
    branchScope: string[] = [],
  ) {
    const limit = Number(filters?.limit ?? 8);
    const take = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 20)) : 8;

    const branchFilter = this.resolveBranchScope(
      branchScope,
      filters?.branchId,
    );
    const transferWhere = this.resolveTransferScope(
      branchScope,
      filters?.branchId,
    );
    const notificationBranchWhere = this.resolveNotificationScope(
      branchScope,
      filters?.branchId,
    );

    const [sales, transfers, notifications] = await Promise.all([
      this.prisma.sale.findMany({
        where: {
          businessId,
          status: 'COMPLETED',
          ...branchFilter,
        },
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true,
          total: true,
          createdAt: true,
          branch: { select: { name: true } },
        },
      }),
      this.prisma.transfer.findMany({
        where: {
          businessId,
          ...transferWhere,
        },
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true,
          status: true,
          createdAt: true,
          sourceBranch: { select: { name: true } },
          destinationBranch: { select: { name: true } },
        },
      }),
      this.prisma.notification.findMany({
        where: {
          businessId,
          archivedAt: null,
          ...notificationBranchWhere,
        },
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true,
          title: true,
          createdAt: true,
          priority: true,
          branch: { select: { name: true } },
        },
      }),
    ]);

    const combined = [
      ...sales.map((row) => ({
        id: `sale:${row.id}`,
        type: 'sale',
        createdAt: row.createdAt,
        title: `Sale recorded`,
        detail: row.branch?.name ?? null,
      })),
      ...transfers.map((row) => ({
        id: `transfer:${row.id}`,
        type: 'transfer',
        createdAt: row.createdAt,
        title: `Transfer ${row.status.toLowerCase()}`,
        detail: `${row.sourceBranch.name} -> ${row.destinationBranch.name}`,
      })),
      ...notifications.map((row) => ({
        id: `notification:${row.id}`,
        type: 'alert',
        createdAt: row.createdAt,
        title: row.title,
        detail: row.branch?.name ?? null,
      })),
    ]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, take);

    return { items: combined };
  }

  async stockValueReport(
    businessId: string,
    userId: string,
    filters?: { branchId?: string },
    branchScope: string[] = [],
  ) {
    const branchFilter = this.resolveBranchScope(
      branchScope,
      filters?.branchId,
    );

    const snapshots = await this.prisma.stockSnapshot.findMany({
      where: { businessId, ...branchFilter },
      include: {
        variant: {
          select: { defaultCost: true, defaultPrice: true },
        },
      },
    });

    const stockValue = snapshots.reduce((sum, row) => {
      const unit = Number(
        row.variant.defaultCost ?? row.variant.defaultPrice ?? 0,
      );
      return sum + Number(row.quantity ?? 0) * unit;
    }, 0);

    return {
      stockValue,
      trackedVariants: snapshots.length,
    };
  }

  private buildDateFilter(start?: string, end?: string) {
    if (!start && !end) {
      // Default to last 90 days to prevent unbounded full-table scans.
      const defaultEnd = new Date();
      const defaultStart = new Date();
      defaultStart.setDate(defaultStart.getDate() - 90);
      defaultStart.setHours(0, 0, 0, 0);
      return { gte: defaultStart, lte: defaultEnd };
    }
    const filter: { gte?: Date; lte?: Date } = {};
    if (start) {
      const startDate = new Date(start);
      startDate.setHours(0, 0, 0, 0);
      filter.gte = startDate;
    }
    if (end) {
      const endDate = new Date(end);
      endDate.setHours(23, 59, 59, 999);
      filter.lte = endDate;
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

  private resolveTransferScope(branchScope: string[], branchId?: string) {
    if (!branchScope.length) {
      if (!branchId) {
        return {};
      }
      return {
        OR: [{ sourceBranchId: branchId }, { destinationBranchId: branchId }],
      };
    }
    if (branchId) {
      if (!branchScope.includes(branchId)) {
        throw new ForbiddenException('Branch-scoped role restriction.');
      }
      return {
        OR: [{ sourceBranchId: branchId }, { destinationBranchId: branchId }],
      };
    }
    return {
      OR: [
        { sourceBranchId: { in: branchScope } },
        { destinationBranchId: { in: branchScope } },
      ],
    };
  }

  private resolveNotificationScope(branchScope: string[], branchId?: string) {
    if (!branchScope.length) {
      return branchId ? { OR: [{ branchId }, { branchId: null }] } : {};
    }
    if (branchId) {
      if (!branchScope.includes(branchId)) {
        throw new ForbiddenException('Branch-scoped role restriction.');
      }
      return { OR: [{ branchId }, { branchId: null }] };
    }
    return { OR: [{ branchId: { in: branchScope } }, { branchId: null }] };
  }
}
