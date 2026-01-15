import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  ApprovalStatus,
  Prisma,
  SaleStatus,
  StockMovementType,
  VatMode,
} from '@prisma/client';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuditService } from '../audit/audit.service';
import { AuditEvent } from '../audit/audit.types';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { UnitsService } from '../units/units.service';
import {
  DEFAULT_POS_POLICIES,
  DEFAULT_STOCK_POLICIES,
} from '../settings/defaults';
import { PermissionsList } from '../rbac/permissions';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';
import { labelWithFallback } from '../common/labels';

const DEFAULT_VAT_RATE = new Prisma.Decimal(18);
const RECEIPT_RETRY_LIMIT = 3;

const isReceiptNumberConflict = (error: unknown) => {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }
  if (error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  if (Array.isArray(target)) {
    return target.includes('receiptNumber');
  }
  return typeof target === 'string' && target.includes('receiptNumber');
};

type PosPolicies = {
  receiptTemplate?: 'THERMAL' | 'A4';
  receiptHeader?: string;
  receiptFooter?: string;
  showBranchContact?: boolean;
  creditEnabled?: boolean;
  shiftTrackingEnabled?: boolean;
  shiftVarianceThreshold?: number;
  discountThresholdPercent?: number;
  discountThresholdAmount?: number;
  refundReturnToStockDefault?: boolean;
  offlineLimits?: {
    maxDurationHours?: number;
    maxSalesCount?: number;
    maxTotalValue?: number;
  };
};

type StockPolicies = {
  negativeStockAllowed?: boolean;
  fifoMode?: string;
  valuationMethod?: 'FIFO' | 'LIFO' | 'AVERAGE';
  expiryPolicy?: 'ALLOW' | 'WARN' | 'BLOCK';
  batchTrackingEnabled?: boolean;
  lowStockThreshold?: number;
};

type DraftLineItem = {
  variantId: string;
  batchId: string | null;
  productName: string;
  variantName: string;
  skuSnapshot: string | null;
  barcodeSnapshot: string | null;
  quantity: Prisma.Decimal;
  unitId: string;
  unitFactor: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  unitCost: Prisma.Decimal | null;
  vatMode: VatMode;
  vatRate: Prisma.Decimal;
  vatAmount: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  lineDiscount: Prisma.Decimal;
};

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly approvalsService: ApprovalsService,
    private readonly notificationsService: NotificationsService,
    private readonly subscriptionService: SubscriptionService,
    private readonly unitsService: UnitsService,
  ) {}

  private calculateLine(
    unitPrice: Prisma.Decimal,
    quantity: Prisma.Decimal,
    vatMode: VatMode,
    vatRate: Prisma.Decimal,
    lineDiscount: Prisma.Decimal,
  ) {
    if (vatMode === VatMode.EXEMPT) {
      const lineTotal = unitPrice.mul(quantity).minus(lineDiscount);
      return { vatAmount: new Prisma.Decimal(0), lineTotal };
    }

    if (vatMode === VatMode.INCLUSIVE) {
      const vatPerUnit = unitPrice.mul(vatRate).div(vatRate.add(100));
      const vatAmount = vatPerUnit.mul(quantity);
      const lineTotal = unitPrice.mul(quantity).minus(lineDiscount);
      return { vatAmount, lineTotal };
    }

    const vatPerUnit = unitPrice.mul(vatRate).div(100);
    const vatAmount = vatPerUnit.mul(quantity);
    const lineTotal = unitPrice
      .add(vatPerUnit)
      .mul(quantity)
      .minus(lineDiscount);
    return { vatAmount, lineTotal };
  }

  private async getPosPolicies(businessId: string): Promise<PosPolicies> {
    const settings = await this.prisma.businessSettings.findUnique({
      where: { businessId },
    });
    return (settings?.posPolicies ?? DEFAULT_POS_POLICIES) as PosPolicies;
  }

  private async getStockPolicies(businessId: string): Promise<StockPolicies> {
    const settings = await this.prisma.businessSettings.findUnique({
      where: { businessId },
    });
    const stockPolicies =
      (settings?.stockPolicies as Record<string, unknown> | null) ?? {};
    return {
      ...DEFAULT_STOCK_POLICIES,
      ...stockPolicies,
    } as StockPolicies;
  }

  private async resolveAverageUnitCost(
    businessId: string,
    branchId: string,
    variantId: string,
  ) {
    const lines = await this.prisma.receivingLine.findMany({
      where: {
        variantId,
        OR: [
          { purchase: { businessId, branchId } },
          { purchaseOrder: { businessId, branchId } },
        ],
      },
      select: { unitCost: true, quantity: true },
    });
    if (!lines.length) {
      return null;
    }
    const totals = lines.reduce(
      (acc, line) => {
        const qty = new Prisma.Decimal(line.quantity);
        const cost = new Prisma.Decimal(line.unitCost);
        acc.quantity = acc.quantity.plus(qty);
        acc.cost = acc.cost.plus(cost.mul(qty));
        return acc;
      },
      { quantity: new Prisma.Decimal(0), cost: new Prisma.Decimal(0) },
    );
    if (totals.quantity.lte(0)) {
      return null;
    }
    return totals.cost.div(totals.quantity);
  }

  private async resolveUnitCost(
    businessId: string,
    branchId: string,
    variantId: string,
    batchId: string | null,
    valuationMethod: StockPolicies['valuationMethod'],
  ) {
    if (batchId) {
      const batch = await this.prisma.batch.findFirst({
        where: { id: batchId, businessId, branchId, variantId },
        select: { unitCost: true },
      });
      if (batch?.unitCost) {
        return new Prisma.Decimal(batch.unitCost);
      }
    }

    if (valuationMethod === 'AVERAGE') {
      return this.resolveAverageUnitCost(businessId, branchId, variantId);
    }

    const orderBy =
      valuationMethod === 'LIFO'
        ? [{ receivedAt: 'desc' as const }]
        : [{ receivedAt: 'asc' as const }];
    const line = await this.prisma.receivingLine.findFirst({
      where: {
        variantId,
        OR: [
          { purchase: { businessId, branchId } },
          { purchaseOrder: { businessId, branchId } },
        ],
      },
      orderBy,
      select: { unitCost: true },
    });
    return line?.unitCost ? new Prisma.Decimal(line.unitCost) : null;
  }

  private async maybeNotifyLowStock(
    businessId: string,
    branchId: string,
    variantId: string,
    quantity: Prisma.Decimal,
  ) {
    const policies = await this.getStockPolicies(businessId);
    const threshold = policies.lowStockThreshold ?? 0;
    if (threshold <= 0) {
      return;
    }
    if (quantity.greaterThan(new Prisma.Decimal(threshold))) {
      return;
    }
    await this.notificationsService.notifyEvent({
      businessId,
      eventKey: 'lowStock',
      title: 'Low stock warning',
      message: `Stock for ${variantId} is at ${quantity.toString()} (threshold ${threshold}).`,
      priority: 'WARNING',
      metadata: {
        branchId,
        variantId,
        quantity: quantity.toString(),
        threshold,
        event: 'LOW_STOCK',
      },
      branchId,
    });
  }

  private async maybeNotifyOfflineLimit(
    businessId: string,
    userId: string,
    offlineDeviceId: string,
    data: { limitType: string; current: number; max: number },
  ) {
    await this.notificationsService.notifyEvent({
      businessId,
      eventKey: 'offlineNearingLimit',
      actorUserId: userId,
      title: 'Offline limit nearing',
      message: `Offline ${data.limitType} at ${data.current}/${data.max}.`,
      priority: 'WARNING',
      metadata: {
        offlineDeviceId,
        limitType: data.limitType,
        current: data.current,
        max: data.max,
        event: 'OFFLINE_NEARING_LIMIT',
      },
    });
  }

  private async ensureVariantAvailable(
    businessId: string,
    branchId: string,
    variantId: string,
  ) {
    const availability = await this.prisma.branchVariantAvailability.findFirst({
      where: { businessId, branchId, variantId },
    });
    if (availability && !availability.isActive) {
      return false;
    }
    return true;
  }

  private async logSaleRejection(
    businessId: string,
    userId: string,
    action: string,
    metadata: Record<string, unknown>,
  ) {
    await this.auditService.logEvent({
      businessId,
      userId,
      action,
      resourceType: 'Sale',
      outcome: 'FAILURE',
      metadata,
    });
  }

  private async assertOfflineLimits(
    businessId: string,
    userId: string,
    offlineDeviceId: string,
    total: Prisma.Decimal,
  ) {
    const posPolicies = await this.getPosPolicies(businessId);
    const stockPolicies = await this.getStockPolicies(businessId);
    const limits = posPolicies.offlineLimits ?? {};
    const maxTotalValue = limits.maxTotalValue ?? 0;
    const maxSalesCount = limits.maxSalesCount ?? 0;
    const maxDurationHours = limits.maxDurationHours ?? 0;

    const offlineDevice = await this.prisma.offlineDevice.findFirst({
      where: { id: offlineDeviceId, businessId, userId },
    });
    if (!offlineDevice) {
      await this.logSaleRejection(
        businessId,
        userId,
        'SALE_OFFLINE_DEVICE_MISSING',
        {
          offlineDeviceId,
        },
      );
      throw new BadRequestException('Offline device is not registered.');
    }

    if (
      maxTotalValue > 0 &&
      total.greaterThan(new Prisma.Decimal(maxTotalValue))
    ) {
      await this.logSaleRejection(businessId, userId, 'SALE_OFFLINE_LIMIT', {
        limitType: 'maxTotalValue',
        maxTotalValue,
        total: total.toNumber(),
      });
      throw new BadRequestException('Offline sale exceeds max total value.');
    }

    if (maxSalesCount > 0) {
      const pending = await this.prisma.sale.count({
        where: {
          businessId,
          offlineDeviceId,
          provisional: true,
          status: SaleStatus.DRAFT,
        },
      });
      const warningThreshold = Math.max(1, Math.floor(maxSalesCount * 0.8));
      if (pending >= warningThreshold && pending < maxSalesCount) {
        await this.maybeNotifyOfflineLimit(
          businessId,
          userId,
          offlineDeviceId,
          {
            limitType: 'queue',
            current: pending,
            max: maxSalesCount,
          },
        );
      }
      if (pending >= maxSalesCount) {
        await this.logSaleRejection(businessId, userId, 'SALE_OFFLINE_LIMIT', {
          limitType: 'maxSalesCount',
          maxSalesCount,
          pending,
        });
        throw new BadRequestException('Offline sale queue limit reached.');
      }
    }

    if (maxDurationHours > 0) {
      const lastSeen = offlineDevice.lastSeenAt ?? offlineDevice.createdAt;
      const elapsedHours =
        (Date.now() - new Date(lastSeen).getTime()) / (1000 * 60 * 60);
      const warningThreshold = maxDurationHours * 0.8;
      if (elapsedHours >= warningThreshold && elapsedHours < maxDurationHours) {
        await this.maybeNotifyOfflineLimit(
          businessId,
          userId,
          offlineDeviceId,
          {
            limitType: 'duration',
            current: Math.round(elapsedHours),
            max: Math.round(maxDurationHours),
          },
        );
      }
      if (elapsedHours > maxDurationHours) {
        await this.logSaleRejection(businessId, userId, 'SALE_OFFLINE_LIMIT', {
          limitType: 'maxDurationHours',
          maxDurationHours,
          elapsedHours,
        });
        throw new BadRequestException('Offline session duration exceeded.');
      }
    }
  }

  private buildBranchCode(name: string) {
    return name
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '');
  }

  private async buildReceiptNumber(
    tx: Prisma.TransactionClient,
    branchId: string,
    branchName: string,
    issuedAt: Date,
    offset: number,
  ) {
    const start = new Date(issuedAt);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    const count = await tx.receipt.count({
      where: {
        issuedAt: { gte: start, lt: end },
        sale: { branchId },
      },
    });
    const seq = count + 1 + offset;
    const seqLabel = String(seq).padStart(3, '0');
    const dateLabel = `${issuedAt.getFullYear()}${String(
      issuedAt.getMonth() + 1,
    ).padStart(2, '0')}${String(issuedAt.getDate()).padStart(2, '0')}`;
    const branchCode = this.buildBranchCode(branchName);
    return `${branchCode}-${dateLabel}-${seqLabel}`;
  }

  async createDraft(
    businessId: string,
    userId: string,
    roleIds: string[],
    userPermissions: string[],
    data: {
      branchId: string;
      cashierId?: string;
      customerId?: string;
      cartDiscount?: number;
      isOffline?: boolean;
      offlineDeviceId?: string;
      lines: {
        variantId: string;
        quantity: number;
        unitId?: string;
        unitPrice?: number;
        vatMode?: VatMode;
        vatRate?: number;
        lineDiscount?: number;
        barcode?: string;
        batchId?: string;
      }[];
    },
  ) {
    const branch = await this.prisma.branch.findFirst({
      where: { id: data.branchId, businessId },
    });
    if (!branch) {
      return null;
    }

    const customer = data.customerId
      ? await this.prisma.customer.findFirst({
          where: { id: data.customerId, businessId, status: 'ACTIVE' },
        })
      : null;

    if (!Array.isArray(data.lines) || data.lines.length === 0) {
      throw new BadRequestException('Sale must contain at least one line.');
    }

    const posPolicies = await this.getPosPolicies(businessId);
    const stockPolicies = await this.getStockPolicies(businessId);
    let openShiftId: string | null = null;
    if (posPolicies.shiftTrackingEnabled) {
      const openShift = await this.prisma.shift.findFirst({
        where: {
          businessId,
          branchId: data.branchId,
          status: 'OPEN',
        },
      });
      if (!openShift) {
        throw new BadRequestException(
          'An open shift is required for POS sales.',
        );
      }
      openShiftId = openShift.id;
    }

    const variantIds = data.lines.map((line) => line.variantId);
    const variants = await this.prisma.variant.findMany({
      where: { businessId, id: { in: variantIds } },
      include: { product: true, barcodes: { where: { isActive: true } } },
    });
    if (variants.length !== variantIds.length) {
      return null;
    }

    const priceListId = customer?.priceListId ?? branch.priceListId ?? null;
    const priceListItems = priceListId
      ? await this.prisma.priceListItem.findMany({
          where: {
            priceListId,
            variantId: { in: variantIds },
          },
        })
      : [];
    const priceListMap = new Map(
      priceListItems.map((item) => [item.variantId, item.price]),
    );

    const variantMap = new Map(
      variants.map((variant) => [variant.id, variant]),
    );
    const lineItems: DraftLineItem[] = [];
    for (const line of data.lines) {
      const variant = variantMap.get(line.variantId);
      if (!variant) {
        throw new BadRequestException('Variant not found.');
      }
      if (variant.status !== 'ACTIVE') {
        throw new BadRequestException('Variant is inactive or archived.');
      }
      const unitPriceRaw =
        line.unitPrice ??
        (priceListMap.has(variant.id)
          ? Number(priceListMap.get(variant.id))
          : variant.defaultPrice
            ? Number(variant.defaultPrice)
            : null);
      if (unitPriceRaw === null || unitPriceRaw === undefined) {
        throw new BadRequestException('Unit price required for sale line.');
      }
      if (
        variant.minPrice &&
        new Prisma.Decimal(unitPriceRaw).lessThan(variant.minPrice)
      ) {
        await this.logSaleRejection(
          businessId,
          userId,
          'SALE_MIN_PRICE_BLOCK',
          {
            variantId: variant.id,
            minPrice: variant.minPrice.toNumber(),
            unitPrice: unitPriceRaw,
          },
        );
        throw new BadRequestException('Unit price below minimum allowed.');
      }
      if (
        line.batchId &&
        !userPermissions.includes(PermissionsList.STOCK_WRITE)
      ) {
        await this.logSaleRejection(
          businessId,
          userId,
          'SALE_BATCH_OVERRIDE_BLOCK',
          {
            variantId: variant.id,
            batchId: line.batchId,
          },
        );
        throw new BadRequestException(
          'Batch selection requires stock permission.',
        );
      }

      const unitResolution = await this.unitsService.resolveUnitFactor({
        businessId,
        variantId: line.variantId,
        unitId: line.unitId,
      });
      const quantity = new Prisma.Decimal(line.quantity);
      const unitPrice = new Prisma.Decimal(unitPriceRaw);
      const vatMode = line.vatMode ?? variant.vatMode ?? VatMode.INCLUSIVE;
      const vatRate = new Prisma.Decimal(line.vatRate ?? DEFAULT_VAT_RATE);
      const lineDiscount = new Prisma.Decimal(line.lineDiscount ?? 0);
      const { vatAmount, lineTotal } = this.calculateLine(
        unitPrice,
        quantity,
        vatMode,
        vatRate,
        lineDiscount,
      );

      const barcodeSnapshot = line.barcode ?? variant.barcodes[0]?.code ?? null;

      const resolvedUnitCost = await this.resolveUnitCost(
        businessId,
        data.branchId,
        line.variantId,
        line.batchId ?? null,
        stockPolicies.valuationMethod,
      );
      const fallbackCost =
        variant.defaultCost !== null && variant.defaultCost !== undefined
          ? new Prisma.Decimal(variant.defaultCost)
          : null;

      lineItems.push({
        variantId: line.variantId,
        batchId: line.batchId ?? null,
        productName: variant.product.name,
        variantName: variant.name,
        skuSnapshot: variant.sku ?? null,
        barcodeSnapshot,
        quantity,
        unitId: unitResolution.unitId,
        unitFactor: unitResolution.unitFactor,
        unitPrice,
        unitCost: resolvedUnitCost ?? fallbackCost,
        vatMode,
        vatRate,
        vatAmount,
        lineTotal,
        lineDiscount,
      });
    }

    for (const line of lineItems) {
      const available = await this.ensureVariantAvailable(
        businessId,
        data.branchId,
        line.variantId,
      );
      if (!available) {
        throw new BadRequestException(
          'Variant is not available at this branch.',
        );
      }
    }

    const subtotal = lineItems.reduce(
      (sum, line) => sum.plus(line.unitPrice.mul(line.quantity)),
      new Prisma.Decimal(0),
    );
    const vatTotal = lineItems.reduce(
      (sum, line) => sum.plus(line.vatAmount),
      new Prisma.Decimal(0),
    );
    const lineDiscountTotal = lineItems.reduce(
      (sum, line) => sum.plus(line.lineDiscount),
      new Prisma.Decimal(0),
    );
    const cartDiscount = new Prisma.Decimal(data.cartDiscount ?? 0);
    const discountTotal = lineDiscountTotal.plus(cartDiscount);
    const total = lineItems
      .reduce((sum, line) => sum.plus(line.lineTotal), new Prisma.Decimal(0))
      .minus(cartDiscount);

    if (data.isOffline) {
      if (!data.offlineDeviceId) {
        throw new BadRequestException('Offline device ID is required.');
      }
      await this.assertOfflineLimits(
        businessId,
        userId,
        data.offlineDeviceId,
        total,
      );
    }

    const sale = await this.prisma.sale.create({
      data: {
        businessId,
        branchId: data.branchId,
        cashierId: data.cashierId ?? userId,
        customerId: customer?.id ?? null,
        shiftId: openShiftId,
        customerNameSnapshot: customer?.name ?? null,
        customerPhoneSnapshot: customer?.phone ?? null,
        customerEmailSnapshot: customer?.email ?? null,
        customerTinSnapshot: customer?.tin ?? null,
        status: SaleStatus.DRAFT,
        isOffline: data.isOffline ?? false,
        offlineDeviceId: data.offlineDeviceId ?? null,
        provisional: data.isOffline ?? false,
        subtotal,
        cartDiscount,
        discountTotal,
        vatTotal,
        total,
        paidAmount: new Prisma.Decimal(0),
        outstandingAmount: total,
        lines: {
          create: lineItems,
        },
      },
      include: { lines: true },
    });

    const thresholdPercent = posPolicies.discountThresholdPercent ?? 10;
    const thresholdAmount = posPolicies.discountThresholdAmount ?? 0;
    const discountPercent = subtotal.greaterThan(0)
      ? discountTotal.div(subtotal).mul(100).toNumber()
      : 0;
    const requiresApproval =
      discountTotal.greaterThan(0) &&
      (discountPercent >= thresholdPercent ||
        (thresholdAmount > 0 &&
          discountTotal.greaterThanOrEqualTo(thresholdAmount)));

    if (requiresApproval) {
      const approval = await this.approvalsService.requestApproval({
        businessId,
        actionType: 'SALE_DISCOUNT',
        requestedByUserId: userId,
        requesterRoleIds: roleIds,
        amount: discountTotal.toNumber(),
        percent: discountPercent,
        metadata: { saleId: sale.id, discountTotal: discountTotal.toNumber() },
        targetType: 'Sale',
        targetId: sale.id,
      });

      if (approval.required) {
        return {
          sale,
          approvalRequired: true,
          approvalId: approval.approval?.id,
        };
      }
    }

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'SALE_DRAFT',
      resourceType: 'Sale',
      resourceId: sale.id,
      outcome: 'SUCCESS',
    });

    await this.notificationsService.notifyEvent({
      businessId,
      eventKey: 'saleDrafted',
      actorUserId: userId,
      title: 'Sale drafted',
      message: `Sale ${labelWithFallback({ id: sale.id })} created as draft.`,
      priority: 'INFO',
      metadata: { saleId: sale.id },
      branchId: sale.branchId,
    });

    return sale;
  }

  async completeSale(
    businessId: string,
    saleId: string,
    userId: string,
    data?: {
      payments?: {
        method: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER' | 'OTHER';
        amount: number;
        reference?: string;
        methodLabel?: string;
      }[];
      idempotencyKey?: string;
      creditDueDate?: string;
      userPermissions?: string[];
    },
  ) {
    if (data?.idempotencyKey) {
      const existing = await this.prisma.sale.findFirst({
        where: { businessId, completionKey: data.idempotencyKey },
        include: { receipt: true, payments: true, lines: true },
      });
      if (existing) {
        return existing;
      }
    }

    const sale = await this.prisma.sale.findUnique({
      where: { id: saleId },
      include: { lines: true },
    });

    if (!sale || sale.businessId !== businessId) {
      return null;
    }
    if (sale.status !== SaleStatus.DRAFT) {
      return sale;
    }

    if (sale.isOffline || sale.provisional) {
      const subscription =
        await this.subscriptionService.getSubscription(businessId);
      if (!subscription?.limits.offline) {
        throw new BadRequestException('Offline sales are not enabled.');
      }
      if (!sale.offlineDeviceId) {
        throw new BadRequestException(
          'Offline device is missing for this sale.',
        );
      }
      const membership = await this.prisma.businessUser.findUnique({
        where: { businessId_userId: { businessId, userId } },
      });
      if (!membership || membership.status !== 'ACTIVE') {
        throw new BadRequestException('User is not active for this business.');
      }
      const offlineDevice = await this.prisma.offlineDevice.findFirst({
        where: { id: sale.offlineDeviceId, businessId, userId },
      });
      if (!offlineDevice) {
        throw new BadRequestException('Offline device is not registered.');
      }
      if (sale.cashierId && sale.cashierId !== userId) {
        throw new BadRequestException('Offline sale owner mismatch.');
      }
      await this.assertOfflineLimits(
        businessId,
        userId,
        sale.offlineDeviceId,
        sale.total,
      );
    }

    const pendingDiscountApproval = await this.prisma.approval.findFirst({
      where: {
        businessId,
        actionType: 'SALE_DISCOUNT',
        status: ApprovalStatus.PENDING,
        targetType: 'Sale',
        targetId: saleId,
      },
    });

    if (pendingDiscountApproval) {
      return { approvalRequired: true, approvalId: pendingDiscountApproval.id };
    }

    await this.subscriptionService.assertLimit(
      businessId,
      'monthlyTransactions',
    );

    const branch = await this.prisma.branch.findFirst({
      where: { id: sale.branchId, businessId },
    });
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });
    if (!branch || !business) {
      return null;
    }
    const customer = sale.customerId
      ? await this.prisma.customer.findFirst({
          where: { id: sale.customerId, businessId },
        })
      : null;
    const priceListId = customer?.priceListId ?? branch.priceListId ?? null;

    const posPolicies = await this.getPosPolicies(businessId);
    const variantIds = sale.lines.map((line) => line.variantId);
    const variants = await this.prisma.variant.findMany({
      where: { businessId, id: { in: variantIds } },
    });
    const variantMap = new Map(
      variants.map((variant) => [variant.id, variant]),
    );

    for (const line of sale.lines) {
      const variant = variantMap.get(line.variantId);
      if (!variant || variant.status !== 'ACTIVE') {
        throw new BadRequestException('Variant is inactive or archived.');
      }
      const available = await this.ensureVariantAvailable(
        businessId,
        sale.branchId,
        line.variantId,
      );
      if (!available) {
        throw new BadRequestException(
          'Variant is not available at this branch.',
        );
      }
    }

    const stockPolicies = await this.getStockPolicies(businessId);

    if (!stockPolicies.negativeStockAllowed) {
      for (const line of sale.lines) {
        const snapshot = await this.prisma.stockSnapshot.findFirst({
          where: {
            businessId,
            branchId: sale.branchId,
            variantId: line.variantId,
          },
        });
        const current = snapshot ? Number(snapshot.quantity) : 0;
        const unitFactor = line.unitFactor ?? new Prisma.Decimal(1);
        const baseQuantity = line.quantity.mul(unitFactor);
        if (current - Number(baseQuantity) < 0) {
          throw new BadRequestException('Insufficient stock for sale.');
        }
      }
    }

    const payments = data?.payments ?? [];
    const paymentsTotal = payments.reduce(
      (sum, payment) => sum + payment.amount,
      0,
    );
    const creditEnabled = posPolicies.creditEnabled ?? false;
    const creditRequested = paymentsTotal < Number(sale.total) - 0.01;
    if (creditRequested && !creditEnabled) {
      throw new BadRequestException('Credit sales are disabled.');
    }
    if (creditRequested) {
      const permissions = data?.userPermissions ?? [];
      if (!permissions.includes(PermissionsList.SALE_CREDIT_CREATE)) {
        throw new BadRequestException('Credit sales require permission.');
      }
    }
    if (paymentsTotal > Number(sale.total) + 0.01) {
      throw new BadRequestException('Payments cannot exceed sale total.');
    }
    if (!creditRequested && payments.length === 0) {
      throw new BadRequestException('Payment method required.');
    }

    let completed: typeof sale | null = null;
    let movementAuditEvents: AuditEvent[] = [];
    let snapshotAuditEvents: AuditEvent[] = [];
    for (let attempt = 0; attempt < RECEIPT_RETRY_LIMIT; attempt += 1) {
      const attemptMovementEvents: AuditEvent[] = [];
      const attemptSnapshotEvents: AuditEvent[] = [];
      try {
        completed = await this.prisma.$transaction(
          async (tx) => {
            const updatedLines = [] as typeof sale.lines;
            for (const line of sale.lines) {
              const variant = variantMap.get(line.variantId);
              if (!variant?.trackStock) {
                updatedLines.push(line);
                continue;
              }

              let batchId = line.batchId;
              if (stockPolicies.batchTrackingEnabled) {
                if (!batchId) {
                  const orderBy: Prisma.BatchOrderByWithRelationInput[] =
                    stockPolicies.fifoMode === 'FEFO'
                      ? [
                          { expiryDate: Prisma.SortOrder.asc },
                          { createdAt: Prisma.SortOrder.asc },
                        ]
                      : [{ createdAt: Prisma.SortOrder.asc }];
                  const batch = await tx.batch.findFirst({
                    where: {
                      businessId,
                      branchId: sale.branchId,
                      variantId: line.variantId,
                    },
                    orderBy,
                  });
                  if (!batch) {
                    throw new BadRequestException(
                      'No batch available for sale line.',
                    );
                  }
                  batchId = batch.id;
                } else {
                  const batch = await tx.batch.findFirst({
                    where: { id: batchId, businessId, branchId: sale.branchId },
                  });
                  if (!batch) {
                    throw new BadRequestException(
                      'Batch not found for sale line.',
                    );
                  }
                }
              }

              if (batchId && batchId !== line.batchId) {
                await tx.saleLine.update({
                  where: { id: line.id },
                  data: { batchId },
                });
              }

              const unitFactor = line.unitFactor ?? new Prisma.Decimal(1);
              const baseQuantity = line.quantity.mul(unitFactor);

              const beforeSnapshot = await tx.stockSnapshot.findFirst({
                where: {
                  businessId: sale.businessId,
                  branchId: sale.branchId,
                  variantId: line.variantId,
                },
              });

              const movement = await tx.stockMovement.create({
                data: {
                  businessId: sale.businessId,
                  branchId: sale.branchId,
                  variantId: line.variantId,
                  createdById: userId,
                  batchId: batchId ?? null,
                  quantity: baseQuantity,
                  unitId: line.unitId ?? null,
                  unitQuantity: line.quantity,
                  movementType: StockMovementType.SALE_OUT,
                },
              });

              const snapshot = await tx.stockSnapshot.upsert({
                where: {
                  businessId_branchId_variantId: {
                    businessId: sale.businessId,
                    branchId: sale.branchId,
                    variantId: line.variantId,
                  },
                },
                create: {
                  businessId: sale.businessId,
                  branchId: sale.branchId,
                  variantId: line.variantId,
                  quantity: baseQuantity.negated(),
                },
                update: {
                  quantity: {
                    decrement: baseQuantity,
                  },
                },
              });
              attemptMovementEvents.push({
                businessId,
                userId,
                action: 'STOCK_MOVEMENT_CREATE',
                resourceType: 'StockMovement',
                resourceId: movement.id,
                outcome: 'SUCCESS',
                metadata: {
                  saleId,
                  branchId: sale.branchId,
                  variantId: line.variantId,
                  batchId: batchId ?? null,
                  quantity: Number(baseQuantity),
                  movementType: StockMovementType.SALE_OUT,
                },
                after: movement as unknown as Record<string, unknown>,
              });
              attemptSnapshotEvents.push({
                businessId,
                userId,
                action: 'STOCK_SNAPSHOT_UPDATE',
                resourceType: 'StockSnapshot',
                resourceId: snapshot.id,
                outcome: 'SUCCESS',
                metadata: {
                  saleId,
                  branchId: sale.branchId,
                  variantId: line.variantId,
                },
                before: beforeSnapshot as unknown as Record<string, unknown>,
                after: snapshot as unknown as Record<string, unknown>,
              });

              updatedLines.push(line);
            }

            const issuedAt = new Date();
            const receiptNumber = await this.buildReceiptNumber(
              tx,
              sale.branchId,
              branch.name,
              issuedAt,
              attempt,
            );

            const paidAmount = new Prisma.Decimal(paymentsTotal);
            const outstandingAmount = sale.total.minus(paidAmount);
            const updatedSale = await tx.sale.update({
              where: { id: saleId },
              data: {
                status: SaleStatus.COMPLETED,
                completedAt: issuedAt,
                completionKey: data?.idempotencyKey ?? null,
                provisional: false,
                paidAmount,
                outstandingAmount,
                creditDueDate: data?.creditDueDate
                  ? new Date(data.creditDueDate)
                  : null,
                payments: {
                  create: payments.map((payment) => ({
                    method: payment.method,
                    methodLabel: payment.methodLabel ?? null,
                    amount: new Prisma.Decimal(payment.amount),
                    reference: payment.reference ?? null,
                  })),
                },
                receipt: {
                  create: {
                    receiptNumber,
                    issuedAt,
                    data: {
                      businessName: business.name,
                      branchName: branch.name,
                      customer: sale.customerNameSnapshot
                        ? {
                            id: sale.customerId,
                            name: sale.customerNameSnapshot,
                            phone: sale.customerPhoneSnapshot,
                            tin: sale.customerTinSnapshot,
                          }
                        : null,
                      priceListId,
                      branchContact: posPolicies.showBranchContact
                        ? {
                            address: branch.address ?? null,
                            phone: branch.phone ?? null,
                          }
                        : null,
                      cashierId: sale.cashierId,
                      saleId: sale.id,
                      receiptTemplate: posPolicies.receiptTemplate ?? 'THERMAL',
                      receiptHeader: posPolicies.receiptHeader ?? '',
                      receiptFooter: posPolicies.receiptFooter ?? '',
                      credit: creditRequested
                        ? {
                            paidAmount,
                            outstandingAmount,
                            dueDate: data?.creditDueDate ?? null,
                          }
                        : null,
                      totals: {
                        subtotal: sale.subtotal,
                        discountTotal: sale.discountTotal,
                        vatTotal: sale.vatTotal,
                        total: sale.total,
                      },
                      payments,
                      lines: updatedLines.map((line) => ({
                        variantId: line.variantId,
                        productName: line.productName,
                        variantName: line.variantName,
                        sku: line.skuSnapshot,
                        barcode: line.barcodeSnapshot,
                        quantity: line.quantity,
                        unitPrice: line.unitPrice,
                        vatMode: line.vatMode,
                        vatRate: line.vatRate,
                        vatAmount: line.vatAmount,
                        lineDiscount: line.lineDiscount,
                        lineTotal: line.lineTotal,
                      })),
                    } as Prisma.InputJsonValue,
                  },
                },
              },
              include: { receipt: true, payments: true, lines: true },
            });

            return updatedSale;
          },
          { timeout: 15000 },
        );
        movementAuditEvents = attemptMovementEvents;
        snapshotAuditEvents = attemptSnapshotEvents;
        break;
      } catch (error) {
        if (isReceiptNumberConflict(error) && attempt < RECEIPT_RETRY_LIMIT - 1) {
          continue;
        }
        throw error;
      }
    }

    if (!completed) {
      throw new BadRequestException('Sale completion failed.');
    }

    for (const event of movementAuditEvents) {
      await this.auditService.logEvent(event);
    }
    for (const event of snapshotAuditEvents) {
      await this.auditService.logEvent(event);
    }

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'SALE_COMPLETE',
      resourceType: 'Sale',
      resourceId: sale.id,
      outcome: 'SUCCESS',
    });

    await this.notificationsService.notifyEvent({
      businessId,
      eventKey: 'saleCompleted',
      actorUserId: userId,
      title: 'Sale completed',
      message: `Sale ${labelWithFallback({ id: sale.id })} completed.`,
      priority: 'INFO',
      metadata: { saleId: sale.id },
      branchId: sale.branchId,
    });

    for (const line of sale.lines) {
      const variant = variantMap.get(line.variantId);
      if (!variant?.trackStock) {
        continue;
      }
      const snapshot = await this.prisma.stockSnapshot.findFirst({
        where: {
          businessId,
          branchId: sale.branchId,
          variantId: line.variantId,
        },
      });
      if (snapshot) {
        await this.maybeNotifyLowStock(
          businessId,
          sale.branchId,
          line.variantId,
          snapshot.quantity,
        );
      }
    }

    return completed;
  }

  async voidSale(businessId: string, saleId: string, userId: string) {
    const sale = await this.prisma.sale.findFirst({
      where: { id: saleId, businessId },
    });
    if (!sale) {
      return null;
    }
    if (sale.status !== SaleStatus.DRAFT) {
      throw new BadRequestException('Only draft sales can be voided.');
    }
    const updated = await this.prisma.sale.update({
      where: { id: saleId },
      data: { status: SaleStatus.VOIDED },
    });

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'SALE_VOID',
      resourceType: 'Sale',
      resourceId: updated.id,
      outcome: 'SUCCESS',
    });

    await this.notificationsService.notifyEvent({
      businessId,
      eventKey: 'saleVoided',
      actorUserId: userId,
      title: 'Sale voided',
      message: `Sale ${labelWithFallback({ id: updated.id })} voided.`,
      priority: 'WARNING',
      metadata: { saleId: updated.id },
      branchId: updated.branchId,
    });

    return updated;
  }

  async refundSale(
    businessId: string,
    saleId: string,
    userId: string,
    roleIds: string[],
    data?: {
      reason?: string;
      returnToStock?: boolean;
      items?: { saleLineId: string; quantity: number }[];
    },
  ) {
    const sale = await this.prisma.sale.findFirst({
      where: { id: saleId, businessId },
      include: { lines: true },
    });
    if (!sale) {
      return null;
    }
    if (sale.status !== SaleStatus.COMPLETED) {
      throw new BadRequestException('Only completed sales can be refunded.');
    }

    const posPolicies = await this.getPosPolicies(businessId);
    const returnToStock =
      data?.returnToStock ?? posPolicies.refundReturnToStockDefault ?? true;

    const items = data?.items?.length
      ? data.items
      : sale.lines.map((line) => ({
          saleLineId: line.id,
          quantity: Number(line.quantity),
        }));

    const lineMap = new Map(sale.lines.map((line) => [line.id, line]));

    const refundLines = items.map((item) => {
      const saleLine = lineMap.get(item.saleLineId);
      if (!saleLine) {
        throw new BadRequestException('Sale line not found for refund.');
      }
      if (item.quantity <= 0 || item.quantity > Number(saleLine.quantity)) {
        throw new BadRequestException('Invalid refund quantity.');
      }
      const quantity = new Prisma.Decimal(item.quantity);
      const lineDiscountPerUnit = saleLine.quantity.greaterThan(0)
        ? saleLine.lineDiscount.div(saleLine.quantity)
        : new Prisma.Decimal(0);
      const lineDiscount = lineDiscountPerUnit.mul(quantity);
      const { vatAmount, lineTotal } = this.calculateLine(
        saleLine.unitPrice,
        quantity,
        saleLine.vatMode,
        saleLine.vatRate,
        lineDiscount,
      );
      const unitFactor = saleLine.unitFactor ?? new Prisma.Decimal(1);
      return {
        saleLine,
        quantity,
        unitFactor,
        vatAmount,
        lineTotal,
        lineDiscount,
      };
    });

    const refundTotal = refundLines.reduce(
      (sum, line) => sum.plus(line.lineTotal),
      new Prisma.Decimal(0),
    );

    const approval = await this.approvalsService.requestApproval({
      businessId,
      actionType: 'SALE_REFUND',
      requestedByUserId: userId,
      requesterRoleIds: roleIds,
      amount: refundTotal.toNumber(),
      reason: data?.reason,
      metadata: { saleId, refundTotal: refundTotal.toNumber() },
      targetType: 'Sale',
      targetId: saleId,
    });

    const refund = await this.prisma.saleRefund.create({
      data: {
        saleId,
        businessId,
        branchId: sale.branchId,
        cashierId: sale.cashierId,
        customerId: sale.customerId,
        customerNameSnapshot: sale.customerNameSnapshot,
        customerPhoneSnapshot: sale.customerPhoneSnapshot,
        customerTinSnapshot: sale.customerTinSnapshot,
        status: approval.required ? 'PENDING' : 'COMPLETED',
        reason: data?.reason ?? null,
        returnToStock,
        total: refundTotal,
        lines: {
          create: refundLines.map((line) => ({
            variantId: line.saleLine.variantId,
            batchId: line.saleLine.batchId ?? null,
            quantity: line.quantity,
            unitId: line.saleLine.unitId ?? null,
            unitFactor: line.unitFactor,
            unitPrice: line.saleLine.unitPrice,
            vatAmount: line.vatAmount,
            lineTotal: line.lineTotal,
          })),
        },
      },
      include: { lines: true },
    });

    if (approval.required) {
      return { approvalRequired: true, approvalId: approval.approval?.id };
    }

    if (returnToStock) {
      for (const line of refundLines) {
        const baseQuantity = line.quantity.mul(line.unitFactor);
        const beforeSnapshot = await this.prisma.stockSnapshot.findFirst({
          where: {
            businessId,
            branchId: sale.branchId,
            variantId: line.saleLine.variantId,
          },
        });
        const movement = await this.prisma.stockMovement.create({
          data: {
            businessId,
            branchId: sale.branchId,
            variantId: line.saleLine.variantId,
            createdById: userId,
            batchId: line.saleLine.batchId ?? null,
            quantity: baseQuantity,
            unitId: line.saleLine.unitId ?? null,
            unitQuantity: line.quantity,
            movementType: StockMovementType.RETURN_IN,
          },
        });

        const snapshot = await this.prisma.stockSnapshot.upsert({
          where: {
            businessId_branchId_variantId: {
              businessId,
              branchId: sale.branchId,
              variantId: line.saleLine.variantId,
            },
          },
          create: {
            businessId,
            branchId: sale.branchId,
            variantId: line.saleLine.variantId,
            quantity: baseQuantity,
          },
          update: {
            quantity: {
              increment: baseQuantity,
            },
          },
        });
        await this.auditService.logEvent({
          businessId,
          userId,
          action: 'STOCK_MOVEMENT_CREATE',
          resourceType: 'StockMovement',
          resourceId: movement.id,
          outcome: 'SUCCESS',
          metadata: {
            saleId,
            refundId: refund.id,
            branchId: sale.branchId,
            variantId: line.saleLine.variantId,
            batchId: line.saleLine.batchId ?? null,
            quantity: Number(baseQuantity),
            movementType: StockMovementType.RETURN_IN,
          },
          after: movement as unknown as Record<string, unknown>,
        });
        await this.auditService.logEvent({
          businessId,
          userId,
          action: 'STOCK_SNAPSHOT_UPDATE',
          resourceType: 'StockSnapshot',
          resourceId: snapshot.id,
          outcome: 'SUCCESS',
          metadata: {
            saleId,
            refundId: refund.id,
            branchId: sale.branchId,
            variantId: line.saleLine.variantId,
          },
          before: beforeSnapshot as unknown as Record<string, unknown>,
          after: snapshot as unknown as Record<string, unknown>,
        });
      }
    }

    const isFullRefund = refundTotal.greaterThanOrEqualTo(sale.total);
    const updated = await this.prisma.sale.update({
      where: { id: saleId },
      data: { status: isFullRefund ? SaleStatus.REFUNDED : sale.status },
    });

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'SALE_REFUND',
      resourceType: 'SaleRefund',
      resourceId: refund.id,
      outcome: 'SUCCESS',
      reason: data?.reason ?? undefined,
      metadata: { saleId, refundTotal: refundTotal.toNumber() },
    });

    await this.notificationsService.notifyEvent({
      businessId,
      eventKey: 'saleRefunded',
      actorUserId: userId,
      title: 'Sale refunded',
      message: `Sale ${labelWithFallback({ id: updated.id })} refunded.`,
      priority: 'WARNING',
      metadata: { saleId: updated.id },
      branchId: updated.branchId,
    });

    return refund;
  }

  async recordSettlement(
    businessId: string,
    saleId: string,
    userId: string,
    data: {
      amount: number;
      method: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER' | 'OTHER';
      reference?: string;
      methodLabel?: string;
    },
  ) {
    const sale = await this.prisma.sale.findFirst({
      where: { id: saleId, businessId },
    });
    if (!sale) {
      return null;
    }
    if (sale.outstandingAmount.lte(0)) {
      return { error: 'Sale has no outstanding balance.' };
    }
    const amount = new Prisma.Decimal(data.amount);
    if (amount.lte(0)) {
      throw new BadRequestException('Settlement amount must be positive.');
    }
    if (amount.greaterThan(sale.outstandingAmount)) {
      throw new BadRequestException('Settlement exceeds outstanding balance.');
    }
    const settlement = await this.prisma.saleSettlement.create({
      data: {
        saleId: sale.id,
        businessId,
        amount,
        method: data.method,
        methodLabel: data.methodLabel ?? null,
        reference: data.reference ?? null,
        receivedById: userId,
      },
    });
    const updated = await this.prisma.sale.update({
      where: { id: sale.id },
      data: {
        paidAmount: { increment: amount },
        outstandingAmount: { decrement: amount },
      },
    });
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'SALE_CREDIT_SETTLE',
      resourceType: 'SaleSettlement',
      resourceId: settlement.id,
      outcome: 'SUCCESS',
      metadata: { saleId: sale.id, amount: amount.toNumber() },
    });
    return { settlement, sale: updated };
  }

  async returnWithoutReceipt(
    businessId: string,
    userId: string,
    roleIds: string[],
    data: {
      branchId: string;
      customerId?: string;
      reason?: string;
      returnToStock?: boolean;
      items: {
        variantId: string;
        quantity: number;
        unitPrice: number;
        unitId?: string;
      }[];
    },
  ) {
    if (!data.items.length) {
      throw new BadRequestException('Return must include at least one item.');
    }
    const branch = await this.prisma.branch.findFirst({
      where: { id: data.branchId, businessId },
    });
    if (!branch) {
      return null;
    }
    const customer = data.customerId
      ? await this.prisma.customer.findFirst({
          where: { id: data.customerId, businessId },
        })
      : null;

    const posPolicies = await this.getPosPolicies(businessId);
    const returnToStock =
      data.returnToStock ?? posPolicies.refundReturnToStockDefault ?? true;

    const approval = await this.approvalsService.requestApproval({
      businessId,
      actionType: 'RETURN_WITHOUT_RECEIPT',
      requestedByUserId: userId,
      requesterRoleIds: roleIds,
      amount: null,
      reason: data.reason,
      metadata: data,
      targetType: 'SaleRefund',
    });

    const total = data.items.reduce(
      (sum, item) =>
        sum.plus(new Prisma.Decimal(item.unitPrice).mul(item.quantity)),
      new Prisma.Decimal(0),
    );

    const refund = await this.prisma.saleRefund.create({
      data: {
        saleId: null,
        businessId,
        branchId: data.branchId,
        cashierId: userId,
        customerId: customer?.id ?? null,
        customerNameSnapshot: customer?.name ?? null,
        customerPhoneSnapshot: customer?.phone ?? null,
        customerTinSnapshot: customer?.tin ?? null,
        status: approval.required ? 'PENDING' : 'COMPLETED',
        reason: data.reason ?? null,
        returnToStock,
        isReturnOnly: true,
        total,
        lines: {
          create: await Promise.all(
            data.items.map(async (item) => {
              const unitResolution = await this.unitsService.resolveUnitFactor({
                businessId,
                variantId: item.variantId,
                unitId: item.unitId,
              });
              return {
                variantId: item.variantId,
                quantity: new Prisma.Decimal(item.quantity),
                unitId: unitResolution.unitId,
                unitFactor: unitResolution.unitFactor,
                unitPrice: new Prisma.Decimal(item.unitPrice),
                vatAmount: new Prisma.Decimal(0),
                lineTotal: new Prisma.Decimal(item.unitPrice).mul(
                  item.quantity,
                ),
              };
            }),
          ),
        },
      },
      include: { lines: true },
    });

    if (approval.required) {
      return { approvalRequired: true, approvalId: approval.approval?.id };
    }

    if (returnToStock) {
      for (const line of refund.lines) {
        const unitFactor = line.unitFactor ?? new Prisma.Decimal(1);
        const baseQuantity = line.quantity.mul(unitFactor);
        const beforeSnapshot = await this.prisma.stockSnapshot.findFirst({
          where: {
            businessId,
            branchId: data.branchId,
            variantId: line.variantId,
          },
        });
        const movement = await this.prisma.stockMovement.create({
          data: {
            businessId,
            branchId: data.branchId,
            variantId: line.variantId,
            createdById: userId,
            quantity: baseQuantity,
            unitId: line.unitId ?? null,
            unitQuantity: line.quantity,
            movementType: StockMovementType.RETURN_IN,
          },
        });
        const snapshot = await this.prisma.stockSnapshot.upsert({
          where: {
            businessId_branchId_variantId: {
              businessId,
              branchId: data.branchId,
              variantId: line.variantId,
            },
          },
          create: {
            businessId,
            branchId: data.branchId,
            variantId: line.variantId,
            quantity: baseQuantity,
          },
          update: {
            quantity: { increment: baseQuantity },
          },
        });
        await this.auditService.logEvent({
          businessId,
          userId,
          action: 'STOCK_MOVEMENT_CREATE',
          resourceType: 'StockMovement',
          resourceId: movement.id,
          outcome: 'SUCCESS',
          metadata: {
            saleId: refund.saleId,
            refundId: refund.id,
            branchId: data.branchId,
            variantId: line.variantId,
            quantity: Number(baseQuantity),
            movementType: StockMovementType.RETURN_IN,
          },
          after: movement as unknown as Record<string, unknown>,
        });
        await this.auditService.logEvent({
          businessId,
          userId,
          action: 'STOCK_SNAPSHOT_UPDATE',
          resourceType: 'StockSnapshot',
          resourceId: snapshot.id,
          outcome: 'SUCCESS',
          metadata: {
            saleId: refund.saleId,
            refundId: refund.id,
            branchId: data.branchId,
            variantId: line.variantId,
          },
          before: beforeSnapshot as unknown as Record<string, unknown>,
          after: snapshot as unknown as Record<string, unknown>,
        });
      }
    }

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'RETURN_WITHOUT_RECEIPT',
      resourceType: 'SaleRefund',
      resourceId: refund.id,
      outcome: 'SUCCESS',
      metadata: { returnToStock },
    });

    return refund;
  }

  async listReceipts(
    businessId: string,
    query: PaginationQuery & {
      search?: string;
      branchId?: string;
      customerId?: string;
      paymentMethod?: string;
      from?: string;
      to?: string;
      includeTotal?: string;
    } = {},
    branchScope: string[] = [],
  ) {
    const pagination = parsePagination(query);
    const search = query.search?.trim();
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    const branchFilter = this.resolveBranchScope(branchScope, query.branchId);
    const saleFilter = {
      businessId,
      ...branchFilter,
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.paymentMethod
        ? { payments: { some: { method: query.paymentMethod as any } } }
        : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };
    const where = {
      sale: saleFilter,
      ...(search
        ? {
            OR: [
              { receiptNumber: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { sale: { id: { contains: search, mode: Prisma.QueryMode.insensitive } } },
              {
                sale: {
                  customer: { name: { contains: search, mode: Prisma.QueryMode.insensitive } },
                },
              },
              {
                sale: {
                  customerNameSnapshot: {
                    contains: search,
                    mode: Prisma.QueryMode.insensitive,
                  },
                },
              },
              {
                sale: {
                  customerPhoneSnapshot: {
                    contains: search,
                    mode: Prisma.QueryMode.insensitive,
                  },
                },
              },
            ],
          }
        : {}),
    };
    const includeTotal =
      query.includeTotal === 'true' || query.includeTotal === '1';
    return Promise.all([
      this.prisma.receipt.findMany({
        where,
        include: { sale: true },
        orderBy: { issuedAt: 'desc' },
        ...pagination,
      }),
      includeTotal
        ? this.prisma.receipt.count({ where })
        : Promise.resolve(null),
    ]).then(([items, total]) =>
      buildPaginatedResponse(
        items,
        pagination.take,
        typeof total === 'number' ? total : undefined,
      ),
    );
  }

  async reprintReceipt(businessId: string, receiptId: string, userId: string) {
    const receipt = await this.prisma.receipt.findFirst({
      where: { id: receiptId, sale: { businessId } },
      include: { sale: true },
    });
    if (!receipt) {
      return null;
    }

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'RECEIPT_REPRINT',
      resourceType: 'Receipt',
      resourceId: receiptId,
      outcome: 'SUCCESS',
      metadata: { saleId: receipt.saleId },
    });

    return receipt;
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
