import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { GainReason, LossReason, Prisma, StockMovementType, VarianceType } from '@prisma/client';
import { ApprovalsService } from '../approvals/approvals.service';
import { generateReferenceNumber } from '../common/reference-number';
import { AuditService } from '../audit/audit.service';
import {
  claimIdempotency,
  clearIdempotency,
  finalizeIdempotency,
} from '../common/idempotency';
import { formatVariantLabel, labelWithFallback } from '../common/labels';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_STOCK_POLICIES } from '../settings/defaults';
import { UnitsService } from '../units/units.service';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';

@Injectable()
export class StockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    @Inject(forwardRef(() => ApprovalsService))
    private readonly approvalsService: ApprovalsService,
    private readonly notificationsService: NotificationsService,
    private readonly unitsService: UnitsService,
  ) {}

  async listStock(
    businessId: string,
    query: PaginationQuery & {
      branchId?: string;
      variantId?: string;
      search?: string;
      status?: string;
      categoryId?: string;
      includeTotal?: string;
    },
    branchScope: string[] = [],
  ) {
    const pagination = parsePagination(query);
    const search = query.search?.trim();
    const branchFilter = this.resolveBranchScope(branchScope, query.branchId);
    const variantFilter: Prisma.VariantWhereInput = {
      ...(query.status ? { status: query.status as any } : {}),
      ...(query.categoryId
        ? { product: { categoryId: query.categoryId } }
        : {}),
      ...(search
        ? { name: { contains: search, mode: Prisma.QueryMode.insensitive } }
        : {}),
    };
    const variantFilterActive = Object.keys(variantFilter).length > 0;
    const where: Prisma.StockSnapshotWhereInput = {
      businessId,
      ...branchFilter,
      ...(query.variantId ? { variantId: query.variantId } : {}),
      ...(variantFilterActive ? { variant: { is: variantFilter } } : {}),
    };
    const includeTotal =
      query.includeTotal === 'true' || query.includeTotal === '1';
    const [items, total] = await Promise.all([
      this.prisma.stockSnapshot.findMany({
        where,
        include: {
          branch: true,
          variant: { include: { baseUnit: true, sellUnit: true, product: { select: { name: true } } } },
        },
        orderBy: { updatedAt: 'desc' },
        ...pagination,
      }),
      includeTotal
        ? this.prisma.stockSnapshot.count({ where })
        : Promise.resolve(null),
    ]);
    // Enrich with sales velocity (avg daily units sold over last 30 days) for days-remaining estimate
    const variantIds = items.map((s) => s.variantId);
    let velocityMap = new Map<string, number>();
    if (variantIds.length > 0) {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const salesData = await this.prisma.saleLine.groupBy({
        by: ['variantId'],
        where: {
          variantId: { in: variantIds },
          sale: { businessId, status: 'COMPLETED', createdAt: { gte: thirtyDaysAgo } },
        },
        _sum: { quantity: true },
      });
      for (const row of salesData) {
        const totalSold = Number(row._sum.quantity ?? 0);
        const dailyAvg = totalSold / 30;
        velocityMap.set(row.variantId, dailyAvg);
      }
    }

    const enriched = items.map((item) => {
      const dailyVelocity = velocityMap.get(item.variantId) ?? 0;
      const qty = Number(item.quantity);
      const daysRemaining = dailyVelocity > 0 ? Math.round(qty / dailyVelocity) : null;
      return {
        ...item,
        dailyVelocity: Math.round(dailyVelocity * 100) / 100,
        daysRemaining,
      };
    });

    return buildPaginatedResponse(
      enriched,
      pagination.take,
      typeof total === 'number' ? total : undefined,
    );
  }

  async listMovements(
    businessId: string,
    query: PaginationQuery & {
      branchId?: string;
      variantId?: string;
      type?: StockMovementType;
      types?: StockMovementType[];
      actorId?: string;
      from?: string;
      to?: string;
      search?: string;
      reason?: string;
      includeTotal?: string;
    },
    branchScope: string[] = [],
  ) {
    const pagination = parsePagination(query);
    const search = query.search?.trim();
    const reason = query.reason?.trim();
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    const branchFilter = this.resolveBranchScope(branchScope, query.branchId);
    const includeTotal =
      query.includeTotal === 'true' || query.includeTotal === '1';
    const where = {
      businessId,
      ...branchFilter,
      ...(query.variantId ? { variantId: query.variantId } : {}),
      ...(query.types?.length
        ? { movementType: { in: query.types } }
        : query.type
          ? { movementType: query.type }
          : {}),
      ...(query.actorId ? { createdById: query.actorId } : {}),
      ...(reason
        ? { reason: { contains: reason, mode: Prisma.QueryMode.insensitive } }
        : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              {
                reason: {
                  contains: search,
                  mode: Prisma.QueryMode.insensitive,
                },
              },
              {
                variant: {
                  name: {
                    contains: search,
                    mode: Prisma.QueryMode.insensitive,
                  },
                },
              },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        include: {
          branch: true,
          variant: {
            include: {
              baseUnit: true,
              sellUnit: true,
              product: { select: { name: true } },
            },
          },
          createdBy: { select: { id: true, name: true, email: true } },
          batch: true,
          approval: {
            select: {
              id: true,
              status: true,
              approvedByUserId: true,
              approvedBy: { select: { name: true } },
              decidedAt: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        ...pagination,
      }),
      includeTotal
        ? this.prisma.stockMovement.count({ where })
        : Promise.resolve(undefined),
    ]);
    return buildPaginatedResponse(items, pagination.take, total);
  }

  async listBatches(
    businessId: string,
    query: PaginationQuery & {
      branchId?: string;
      variantId?: string;
      search?: string;
    },
    branchScope: string[] = [],
  ) {
    const pagination = parsePagination(query);
    const search = query.search?.trim();
    const branchFilter = this.resolveBranchScope(branchScope, query.branchId);
    const items = await this.prisma.batch.findMany({
      where: {
        businessId,
        ...branchFilter,
        ...(query.variantId ? { variantId: query.variantId } : {}),
        ...(search
          ? { code: { contains: search, mode: Prisma.QueryMode.insensitive } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      ...pagination,
    });
    return buildPaginatedResponse(items, pagination.take);
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
    } as {
      negativeStockAllowed?: boolean;
      fifoMode?: string;
      valuationMethod?: 'FIFO' | 'LIFO' | 'AVERAGE';
      expiryPolicy?: 'ALLOW' | 'WARN' | 'BLOCK';
      batchTrackingEnabled?: boolean;
      transferBatchPolicy?: 'PRESERVE' | 'RECREATE';
      lowStockThreshold?: number;
    };
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
    batchId: string | null | undefined,
    valuationMethod: 'FIFO' | 'LIFO' | 'AVERAGE' | undefined,
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
    const variant = await this.prisma.variant.findFirst({
      where: { id: variantId, businessId },
      select: { name: true, product: { select: { name: true } } },
    });
    const variantLabel = formatVariantLabel({
      id: variantId,
      name: variant?.name ?? variantId,
      productName: variant?.product?.name ?? null,
    });
    await this.notificationsService.notifyEvent({
      businessId,
      eventKey: 'lowStock',
      title: 'Low stock warning',
      message: `${variantLabel} is at ${quantity.toString()} (threshold ${threshold}).`,
      priority: 'WARNING',
      metadata: {
        branchId,
        variantId,
        variantName: variant?.name ?? null,
        productName: variant?.product?.name ?? null,
        quantity: quantity.toString(),
        threshold,
        event: 'LOW_STOCK',
      },
      branchId,
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

  private async ensureExpiryPolicy(
    policy: 'ALLOW' | 'WARN' | 'BLOCK',
    businessId: string,
    batchId?: string | null,
  ) {
    if (!batchId || policy === 'ALLOW') {
      return { allowed: true };
    }
    const batch = await this.prisma.batch.findFirst({
      where: { id: batchId, businessId },
    });
    if (!batch?.expiryDate) {
      return { allowed: true };
    }
    const expired = batch.expiryDate.getTime() < Date.now();
    if (expired && policy === 'BLOCK') {
      return { allowed: false, reason: 'Batch is expired.' };
    }
    return { allowed: true, expired };
  }

  async createAdjustment(
    businessId: string,
    userId: string,
    roleIds: string[],
    data: {
      branchId: string;
      variantId: string;
      quantity: number;
      unitId?: string;
      reason?: string;
      type: 'POSITIVE' | 'NEGATIVE';
      batchId?: string;
      lossReason?: LossReason;
      gainReason?: GainReason;
      idempotencyKey?: string;
    },
    options?: { skipApproval?: boolean; approvalId?: string },
  ) {
    const [branch, variant] = await Promise.all([
      this.prisma.branch.findFirst({
        where: { id: data.branchId, businessId },
      }),
      this.prisma.variant.findFirst({
        where: { id: data.variantId, businessId },
        include: { product: { select: { name: true } } },
      }),
    ]);
    if (!branch || !variant) {
      return null;
    }
    if (!variant.trackStock) {
      return null;
    }
    const available = await this.ensureVariantAvailable(
      businessId,
      data.branchId,
      data.variantId,
    );
    if (!available) {
      return null;
    }

    const policies = await this.getStockPolicies(businessId);
    if (!policies.batchTrackingEnabled) {
      data.batchId = undefined;
    }

    if (data.type === 'NEGATIVE' && !data.lossReason) {
      throw new BadRequestException('Loss reason is required for negative adjustments.');
    }

    if (policies.batchTrackingEnabled) {
      if (data.batchId) {
        const batch = await this.prisma.batch.findUnique({
          where: { id: data.batchId },
        });
        if (!batch || batch.businessId !== businessId) {
          throw new BadRequestException('Batch not found.');
        }
      }
      const expiryCheck = await this.ensureExpiryPolicy(
        policies.expiryPolicy ?? 'WARN',
        businessId,
        data.batchId,
      );
      if (!expiryCheck.allowed) {
        throw new BadRequestException(expiryCheck.reason ?? 'Batch is expired.');
      }
    }

    const unitResolution = await this.unitsService.resolveUnitFactor({
      businessId,
      variantId: data.variantId,
      unitId: data.unitId,
    });
    const unit = await this.prisma.unit.findUnique({
      where: { id: unitResolution.unitId },
      select: { label: true, code: true },
    });
    const unitLabel = unit?.label ?? unit?.code ?? null;
    const unitQuantity = new Prisma.Decimal(data.quantity);
    const baseQuantity = this.unitsService.toBaseQuantity(
      unitQuantity,
      unitResolution.unitFactor,
    );

    const approvalPayload = {
      branchId: data.branchId,
      variantId: data.variantId,
      quantity: data.quantity,
      unitId: unitResolution.unitId,
      reason: data.reason,
      type: data.type,
      batchId: data.batchId,
      lossReason: data.lossReason,
      gainReason: data.gainReason,
      idempotencyKey: data.idempotencyKey,
    };
    if (!options?.skipApproval) {
      const approval = await this.approvalsService.requestApproval({
        businessId,
        actionType: 'STOCK_ADJUSTMENT',
        requestedByUserId: userId,
        requesterRoleIds: roleIds,
        amount: Math.abs(Number(baseQuantity)),
        reason: data.reason,
        metadata: {
          ...data,
          unitId: unitResolution.unitId,
          unitLabel,
          baseQuantity: Number(baseQuantity),
          variantName: variant.name,
          productName: variant.product?.name ?? null,
          branchName: branch.name,
          pendingAction: {
            type: 'STOCK_ADJUSTMENT',
            payload: approvalPayload,
          },
        },
        targetType: 'Variant',
        targetId: data.variantId,
      });

      if (approval.required) {
        return { approvalRequired: true, approvalId: approval.approval?.id };
      }
    }

    const idempotencyKey =
      data.idempotencyKey ??
      (options?.approvalId ? `approval:${options.approvalId}` : undefined);
    const idempotency = await claimIdempotency(
      this.prisma,
      businessId,
      'stock.adjustment',
      idempotencyKey,
    );
    if (idempotency?.existing) {
      if (idempotency.record.resourceId) {
        return this.prisma.stockMovement.findUnique({
          where: { id: idempotency.record.resourceId },
        });
      }
      throw new BadRequestException('Idempotency key already used.');
    }

    const movementType =
      data.type === 'POSITIVE'
        ? StockMovementType.ADJUSTMENT_POSITIVE
        : StockMovementType.ADJUSTMENT_NEGATIVE;

    const quantity = baseQuantity;

    let movement;
    let lossEntryId: string | null = null;
    let gainEntryId: string | null = null;
    let beforeSnapshot: { id: string; quantity: Prisma.Decimal } | null = null;

    // Reasons that represent actual financial losses (stock gone, no value recovered)
    const LOSS_REASONS: LossReason[] = [
      LossReason.DAMAGED, LossReason.LOST, LossReason.STOLEN,
      LossReason.EXPIRED, LossReason.SHRINKAGE, LossReason.OTHER,
    ];
    // Reasons that represent stock that was purchased (cost should be recorded)
    const PURCHASE_REASONS: GainReason[] = [
      GainReason.UNRECORDED_PURCHASE, GainReason.INITIAL_STOCK,
    ];

    const isActualLoss = data.type === 'NEGATIVE' && data.lossReason && LOSS_REASONS.includes(data.lossReason);
    const isPurchaseCost = data.type === 'POSITIVE' && data.gainReason && PURCHASE_REASONS.includes(data.gainReason);

    // Pre-compute unit cost before opening the transaction (read-only operation)
    let resolvedUnitCost: Prisma.Decimal | null = null;
    if (isActualLoss || isPurchaseCost) {
      resolvedUnitCost =
        (await this.resolveUnitCost(
          businessId,
          data.branchId,
          data.variantId,
          data.batchId ?? null,
          policies.valuationMethod,
        )) ?? new Prisma.Decimal(variant.defaultCost ?? 0);
    }

    let afterSnapshot: { id: string; quantity: Prisma.Decimal } | null = null;
    try {
      const txResult = await this.prisma.$transaction(async (tx) => {
        const txBeforeSnapshot = await tx.stockSnapshot.findFirst({
          where: { businessId, branchId: data.branchId, variantId: data.variantId },
        });

        if (data.type === 'NEGATIVE' && !policies.negativeStockAllowed) {
          const current = txBeforeSnapshot ? Number(txBeforeSnapshot.quantity) : 0;
          if (current - Number(baseQuantity) < 0) {
            throw new BadRequestException('Negative stock is not allowed.');
          }
        }

        const txMovement = await tx.stockMovement.create({
          data: {
            businessId,
            branchId: data.branchId,
            variantId: data.variantId,
            createdById: userId,
            quantity,
            unitId: unitResolution.unitId,
            unitQuantity,
            movementType,
            reason: data.reason,
            batchId: data.batchId ?? null,
            approvalId: options?.approvalId ?? null,
          },
        });

        // Financial records based on reason:
        // - Actual losses (DAMAGED, STOLEN, etc.) → LossEntry (reduces profit)
        // - SOLD_OUTSIDE_POS / CORRECTION → no financial record
        // - UNRECORDED_PURCHASE / INITIAL_STOCK → Expense with STOCK_COST (reduces profit)
        // - FOUND_STOCK / RETURN_NOT_LOGGED / CORRECTION / OTHER → no financial record
        let txLossEntryId: string | null = null;
        if (isActualLoss && resolvedUnitCost) {
          const totalCost = resolvedUnitCost.mul(quantity);
          const lossEntry = await tx.lossEntry.create({
            data: {
              businessId,
              branchId: data.branchId,
              variantId: data.variantId,
              stockMovementId: txMovement.id,
              quantity,
              unitCost: resolvedUnitCost,
              totalCost,
              reason: data.lossReason!,
              note: data.reason ?? null,
            },
          });
          txLossEntryId = lossEntry.id;
        }

        let txExpenseId: string | null = null;
        if (isPurchaseCost && resolvedUnitCost) {
          const totalCost = resolvedUnitCost.mul(quantity);
          const settings = await tx.businessSettings.findFirst({
            where: { businessId },
            select: { localeSettings: true },
          });
          const locale = (settings?.localeSettings as Record<string, unknown> | null) ?? {};
          const currency = String(locale.currency ?? 'TZS');
          const expense = await tx.expense.create({
            data: {
              businessId,
              branchId: data.branchId,
              category: 'STOCK_COST',
              amount: totalCost,
              currency,
              note: `${data.gainReason}: ${variant.product?.name ?? ''} – ${variant.name} (x${quantity})`,
              createdBy: userId,
            },
          });
          txExpenseId = expense.id;
        }

        const txGainEntryId: string | null = null;

        const txSnapshot = await tx.stockSnapshot.upsert({
          where: {
            businessId_branchId_variantId: {
              businessId,
              branchId: data.branchId,
              variantId: data.variantId,
            },
          },
          create: {
            businessId,
            branchId: data.branchId,
            variantId: data.variantId,
            quantity,
          },
          update: {
            quantity: {
              increment:
                data.type === 'POSITIVE' ? quantity : quantity.negated(),
            },
          },
        });

        return { txMovement, txLossEntryId, txGainEntryId, txExpenseId, txSnapshot, txBeforeSnapshot };
      });

      movement = txResult.txMovement;
      lossEntryId = txResult.txLossEntryId;
      gainEntryId = txResult.txGainEntryId;
      afterSnapshot = txResult.txSnapshot;
      beforeSnapshot = txResult.txBeforeSnapshot;

      await this.maybeNotifyLowStock(
        businessId,
        data.branchId,
        data.variantId,
        txResult.txSnapshot.quantity,
      );
    } catch (error) {
      if (idempotency) {
        await clearIdempotency(this.prisma, idempotency.record.id);
      }
      throw error;
    }

    if (idempotency) {
      await finalizeIdempotency(this.prisma, idempotency.record.id, {
        resourceType: 'StockMovement',
        resourceId: movement.id,
        metadata: { movementType },
      });
    }

    const toQuantityNumber = (value?: Prisma.Decimal | null) => {
      if (value === null || value === undefined) {
        return null;
      }
      return value.toNumber();
    };
    const stockBefore = toQuantityNumber(beforeSnapshot?.quantity);
    const stockAfter = toQuantityNumber(afterSnapshot?.quantity);
    const stockDelta =
      stockBefore === null || stockAfter === null
        ? null
        : stockAfter - stockBefore;

    await this.auditService.logEvent({
      businessId,
      userId,
      branchId: data.branchId,
      action: 'STOCK_ADJUST',
      resourceType: 'StockMovement',
      resourceId: movement.id,
      outcome: 'SUCCESS',
      reason: data.reason ?? undefined,
      metadata: {
        ...data,
        lossEntryId,
        gainEntryId,
        stockBefore,
        stockAfter,
        stockDelta,
        snapshotId: afterSnapshot?.id ?? null,
      },
    });
    if (afterSnapshot) {
      await this.auditService.logEvent({
        businessId,
        userId,
        branchId: data.branchId,
        action: 'STOCK_SNAPSHOT_UPDATE',
        resourceType: 'StockSnapshot',
        resourceId: afterSnapshot.id,
        outcome: 'SUCCESS',
        reason: data.reason ?? undefined,
        metadata: {
          variantId: data.variantId,
          branchId: data.branchId,
          movementId: movement.id,
          movementType,
        },
        before: beforeSnapshot as unknown as Record<string, unknown>,
        after: afterSnapshot as unknown as Record<string, unknown>,
      });
    }

    const variantLabel = formatVariantLabel({
      id: data.variantId,
      name: variant?.name ?? data.variantId,
      productName: variant?.product?.name ?? null,
    });

    await this.notificationsService.notifyEvent({
      businessId,
      eventKey: 'stockAdjusted',
      actorUserId: userId,
      title: 'Stock adjusted',
      message: `Stock adjustment recorded for ${variantLabel}.`,
      priority: 'INFO',
      metadata: {
        movementId: movement.id,
        variantId: data.variantId,
        variantName: variant?.name ?? null,
        productName: variant?.product?.name ?? null,
      },
      branchId: data.branchId,
    });

    return movement;
  }

  async createStockCount(
    businessId: string,
    userId: string,
    roleIds: string[],
    data: {
      branchId: string;
      variantId: string;
      countedQuantity: number;
      unitId?: string;
      expectedQuantity?: number;
      reason?: string;
      shortageReason?: string;
      surplusReason?: string;
      batchId?: string;
      idempotencyKey?: string;
    },
    options?: { skipApproval?: boolean; approvalId?: string },
  ) {
    const [branch, variant] = await Promise.all([
      this.prisma.branch.findFirst({
        where: { id: data.branchId, businessId },
      }),
      this.prisma.variant.findFirst({
        where: { id: data.variantId, businessId },
        include: { product: { select: { name: true } } },
      }),
    ]);
    if (!branch || !variant) {
      return null;
    }
    if (!variant.trackStock) {
      return null;
    }
    if (data.countedQuantity < 0) {
      throw new BadRequestException('Counted quantity cannot be negative.');
    }
    const available = await this.ensureVariantAvailable(
      businessId,
      data.branchId,
      data.variantId,
    );
    if (!available) {
      return null;
    }

    const policies = await this.getStockPolicies(businessId);
    if (!policies.batchTrackingEnabled) {
      data.batchId = undefined;
    }
    if (policies.batchTrackingEnabled) {
      if (data.batchId) {
        const batch = await this.prisma.batch.findUnique({
          where: { id: data.batchId },
        });
        if (!batch || batch.businessId !== businessId) {
          throw new BadRequestException('Batch not found.');
        }
      }
      const expiryCheck = await this.ensureExpiryPolicy(
        policies.expiryPolicy ?? 'WARN',
        businessId,
        data.batchId,
      );
      if (!expiryCheck.allowed) {
        throw new BadRequestException(expiryCheck.reason ?? 'Batch is expired.');
      }
    }

    const unitResolution = await this.unitsService.resolveUnitFactor({
      businessId,
      variantId: data.variantId,
      unitId: data.unitId,
    });
    const unit = await this.prisma.unit.findUnique({
      where: { id: unitResolution.unitId },
      select: { label: true, code: true },
    });
    const unitLabel = unit?.label ?? unit?.code ?? null;
    const unitQuantity = new Prisma.Decimal(data.countedQuantity);
    const baseCountedQuantity = this.unitsService.toBaseQuantity(
      unitQuantity,
      unitResolution.unitFactor,
    );

    const snapshot = await this.prisma.stockSnapshot.findFirst({
      where: {
        businessId,
        branchId: data.branchId,
        variantId: data.variantId,
      },
    });
    const expectedQuantity = snapshot ? Number(snapshot.quantity) : 0;
    let beforeSnapshot: typeof snapshot = null;

    const approvalPayload = {
      branchId: data.branchId,
      variantId: data.variantId,
      countedQuantity: data.countedQuantity,
      unitId: unitResolution.unitId,
      reason: data.reason,
      batchId: data.batchId,
      idempotencyKey: data.idempotencyKey,
    };
    if (!options?.skipApproval) {
      const approval = await this.approvalsService.requestApproval({
        businessId,
        actionType: 'STOCK_COUNT',
        requestedByUserId: userId,
        requesterRoleIds: roleIds,
        amount: Math.abs(Number(baseCountedQuantity) - expectedQuantity),
        reason: data.reason,
        metadata: {
          ...data,
          expectedQuantity,
          unitId: unitResolution.unitId,
          unitLabel,
          baseCountedQuantity: Number(baseCountedQuantity),
          variance: Number(baseCountedQuantity) - expectedQuantity,
          variantName: variant.name,
          productName: variant.product?.name ?? null,
          branchName: branch.name,
          pendingAction: {
            type: 'STOCK_COUNT',
            payload: approvalPayload,
          },
        },
        targetType: 'Variant',
        targetId: data.variantId,
      });

      if (approval.required) {
        return { approvalRequired: true, approvalId: approval.approval?.id };
      }
    }

    const idempotencyKey =
      data.idempotencyKey ??
      (options?.approvalId ? `approval:${options.approvalId}` : undefined);
    const idempotency = await claimIdempotency(
      this.prisma,
      businessId,
      'stock.count',
      idempotencyKey,
    );
    if (idempotency?.existing) {
      if (idempotency.record.resourceId) {
        return this.prisma.stockMovement.findUnique({
          where: { id: idempotency.record.resourceId },
        });
      }
      throw new BadRequestException('Idempotency key already used.');
    }

    // Signed variance: positive = surplus, negative = shortage.
    // Do NOT use Math.abs — the sign carries meaningful information.
    const variance = Number(baseCountedQuantity) - expectedQuantity;
    const varianceQuantity = new Prisma.Decimal(variance);
    const movementType = StockMovementType.STOCK_COUNT_VARIANCE;

    // Pre-compute unit cost for variance financial tracking
    let varianceUnitCost: Prisma.Decimal | null = null;
    if (variance !== 0) {
      varianceUnitCost =
        (await this.resolveUnitCost(
          businessId,
          data.branchId,
          data.variantId,
          data.batchId ?? null,
          policies.valuationMethod,
        )) ?? new Prisma.Decimal(variant.defaultCost ?? 0);
    }

    let movement;
    let varianceCostId: string | null = null;
    let afterSnapshot: { id: string; quantity: Prisma.Decimal } | null = null;
    try {
      const txResult = await this.prisma.$transaction(async (tx) => {
        const txBeforeSnapshot = await tx.stockSnapshot.findFirst({
          where: { businessId, branchId: data.branchId, variantId: data.variantId },
        });

        if (!policies.negativeStockAllowed && Number(baseCountedQuantity) < 0) {
          throw new BadRequestException('Negative stock is not allowed.');
        }

        const txMovement = await tx.stockMovement.create({
          data: {
            businessId,
            branchId: data.branchId,
            variantId: data.variantId,
            createdById: userId,
            quantity: varianceQuantity,
            unitId: unitResolution.unitId,
            unitQuantity,
            movementType,
            reason: data.reason,
            batchId: data.batchId ?? null,
            approvalId: options?.approvalId ?? null,
          },
        });

        // Financial logic based on variance reason:
        // Shortages: DAMAGED/LOST/STOLEN/EXPIRED/SHRINKAGE/OTHER → loss (reduces profit)
        //            SOLD_OUTSIDE_POS/CORRECTION → no financial impact
        // Surpluses: UNRECORDED_PURCHASE → expense (stock cost, reduces profit)
        //            FOUND_STOCK/RETURN_NOT_LOGGED/CORRECTION/OTHER → no financial impact
        const SHORTAGE_LOSS_REASONS = ['DAMAGED', 'LOST', 'STOLEN', 'EXPIRED', 'SHRINKAGE', 'OTHER'];
        const SURPLUS_COST_REASONS = ['UNRECORDED_PURCHASE'];

        const isShortage = variance < 0;
        const shortageReason = isShortage ? (data.shortageReason ?? 'OTHER') : null;
        const surplusReason = !isShortage && variance > 0 ? (data.surplusReason ?? 'OTHER') : null;
        const isFinancialLoss = isShortage && shortageReason && SHORTAGE_LOSS_REASONS.includes(shortageReason);
        const isStockCost = !isShortage && surplusReason && SURPLUS_COST_REASONS.includes(surplusReason);

        let txVarianceCostId: string | null = null;
        if (variance !== 0 && varianceUnitCost && isFinancialLoss) {
          // Shortage with loss reason → create variance cost (reduces profit via P&L)
          const absQuantity = new Prisma.Decimal(Math.abs(variance));
          const totalCost = varianceUnitCost.mul(absQuantity);
          const varianceCost = await tx.stockCountVarianceCost.create({
            data: {
              businessId,
              branchId: data.branchId,
              variantId: data.variantId,
              stockMovementId: txMovement.id,
              quantity: absQuantity,
              unitCost: varianceUnitCost,
              totalCost,
              varianceType: VarianceType.SHORTAGE,
              shortageReason: shortageReason as never,
              reason: data.reason ?? null,
            },
          });
          txVarianceCostId = varianceCost.id;
        }

        if (variance > 0 && varianceUnitCost && isStockCost) {
          // Surplus with purchase reason → create expense (stock cost)
          const absQuantity = new Prisma.Decimal(Math.abs(variance));
          const totalCost = varianceUnitCost.mul(absQuantity);
          const settings = await tx.businessSettings.findFirst({
            where: { businessId },
            select: { localeSettings: true },
          });
          const locale = (settings?.localeSettings as Record<string, unknown> | null) ?? {};
          const currency = String(locale.currency ?? 'TZS');
          await tx.expense.create({
            data: {
              businessId,
              branchId: data.branchId,
              referenceNumber: await generateReferenceNumber(tx, 'expense', businessId),
              category: 'STOCK_COST',
              amount: totalCost,
              currency,
              note: `Stock count surplus — unrecorded purchase: ${variant.product?.name ?? ''} – ${variant.name} (x${absQuantity})`,
              createdBy: userId,
            },
          });
        }

        const txSnapshot = await tx.stockSnapshot.upsert({
          where: {
            businessId_branchId_variantId: {
              businessId,
              branchId: data.branchId,
              variantId: data.variantId,
            },
          },
          create: {
            businessId,
            branchId: data.branchId,
            variantId: data.variantId,
            quantity: baseCountedQuantity,
          },
          update: {
            quantity: baseCountedQuantity,
          },
        });

        return { txMovement, txVarianceCostId, txSnapshot, txBeforeSnapshot };
      });

      movement = txResult.txMovement;
      varianceCostId = txResult.txVarianceCostId;
      afterSnapshot = txResult.txSnapshot;
      beforeSnapshot = txResult.txBeforeSnapshot;
      await this.maybeNotifyLowStock(
        businessId,
        data.branchId,
        data.variantId,
        txResult.txSnapshot.quantity,
      );
    } catch (error) {
      if (idempotency) {
        await clearIdempotency(this.prisma, idempotency.record.id);
      }
      throw error;
    }

    if (idempotency) {
      await finalizeIdempotency(this.prisma, idempotency.record.id, {
        resourceType: 'StockMovement',
        resourceId: movement.id,
        metadata: { movementType },
      });
    }

    await this.auditService.logEvent({
      businessId,
      userId,
      branchId: data.branchId,
      action: 'STOCK_COUNT',
      resourceType: 'StockMovement',
      resourceId: movement.id,
      outcome: 'SUCCESS',
      reason: data.reason ?? undefined,
      metadata: {
        ...data,
        expectedQuantity,
        variance: Number(baseCountedQuantity) - expectedQuantity,
        varianceCostId,
      },
    });
    if (afterSnapshot) {
      await this.auditService.logEvent({
        businessId,
        userId,
        branchId: data.branchId,
        action: 'STOCK_SNAPSHOT_UPDATE',
        resourceType: 'StockSnapshot',
        resourceId: afterSnapshot.id,
        outcome: 'SUCCESS',
        reason: data.reason ?? undefined,
        metadata: {
          variantId: data.variantId,
          branchId: data.branchId,
          movementId: movement.id,
          movementType,
        },
        before: beforeSnapshot as unknown as Record<string, unknown>,
        after: afterSnapshot as unknown as Record<string, unknown>,
      });
    }

    await this.notificationsService.notifyEvent({
      businessId,
      eventKey: 'stockCountRecorded',
      actorUserId: userId,
      title: 'Stock count recorded',
      message: `Stock count recorded for ${formatVariantLabel({
        id: data.variantId,
        name: variant?.name ?? data.variantId,
        productName: variant?.product?.name ?? null,
      })}.`,
      priority: 'INFO',
      metadata: {
        movementId: movement.id,
        variantId: data.variantId,
        variantName: variant?.name ?? null,
        productName: variant?.product?.name ?? null,
      },
      branchId: data.branchId,
    });

    return movement;
  }

  async generateBatchCode(businessId: string, branchId: string): Promise<string> {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    const prefix = `BATCH-${dateStr}`;

    const existing = await this.prisma.batch.findMany({
      where: {
        businessId,
        branchId,
        code: { startsWith: prefix },
      },
      select: { code: true },
      orderBy: { code: 'desc' },
      take: 1,
    });

    let sequence = 1;
    if (existing.length > 0) {
      const lastCode = existing[0].code;
      const lastSeq = parseInt(lastCode.split('-').pop() || '0', 10);
      sequence = lastSeq + 1;
    }

    return `${prefix}-${String(sequence).padStart(3, '0')}`;
  }

  async createBatch(
    businessId: string,
    userId: string,
    data: {
      branchId: string;
      variantId: string;
      code?: string;
      expiryDate?: string;
    },
  ) {
    const [branch, variant] = await Promise.all([
      this.prisma.branch.findFirst({
        where: { id: data.branchId, businessId },
      }),
      this.prisma.variant.findFirst({
        where: { id: data.variantId, businessId },
      }),
    ]);
    if (!branch || !variant) {
      return null;
    }

    const policies = await this.getStockPolicies(businessId);
    if (!policies.batchTrackingEnabled) {
      throw new BadRequestException('Batch tracking is disabled.');
    }

    const code = data.code?.trim() || await this.generateBatchCode(businessId, data.branchId);

    const batch = await this.prisma.batch.create({
      data: {
        businessId,
        branchId: data.branchId,
        variantId: data.variantId,
        code,
        expiryDate: data.expiryDate ? new Date(data.expiryDate) : null,
        unitCost:
          variant.defaultCost !== null && variant.defaultCost !== undefined
            ? new Prisma.Decimal(variant.defaultCost)
            : null,
      },
    });

    await this.auditService.logEvent({
      businessId,
      userId,
      branchId: data.branchId,
      action: 'BATCH_CREATE',
      resourceType: 'Batch',
      resourceId: batch.id,
      outcome: 'SUCCESS',
      metadata: data,
    });

    return batch;
  }

  async listReorderPoints(
    businessId: string,
    query: PaginationQuery & { branchId?: string; variantId?: string },
    branchScope: string[] = [],
  ) {
    const pagination = parsePagination(query);
    const branchFilter = this.resolveBranchScope(branchScope, query.branchId);
    const items = await this.prisma.reorderPoint.findMany({
      where: {
        businessId,
        ...branchFilter,
        ...(query.variantId ? { variantId: query.variantId } : {}),
      },
      include: {
        branch: true,
        variant: true,
      },
      orderBy: { updatedAt: 'desc' },
      ...pagination,
    });
    return buildPaginatedResponse(items, pagination.take);
  }

  async upsertReorderPoint(
    businessId: string,
    userId: string,
    data: {
      branchId: string;
      variantId: string;
      minQuantity: number;
      reorderQuantity: number;
    },
  ) {
    const [branch, variant] = await Promise.all([
      this.prisma.branch.findFirst({
        where: { id: data.branchId, businessId },
      }),
      this.prisma.variant.findFirst({
        where: { id: data.variantId, businessId },
      }),
    ]);
    if (!branch || !variant) {
      return null;
    }

    const record = await this.prisma.reorderPoint.upsert({
      where: {
        businessId_branchId_variantId: {
          businessId,
          branchId: data.branchId,
          variantId: data.variantId,
        },
      },
      create: {
        businessId,
        branchId: data.branchId,
        variantId: data.variantId,
        minQuantity: new Prisma.Decimal(data.minQuantity),
        reorderQuantity: new Prisma.Decimal(data.reorderQuantity),
      },
      update: {
        minQuantity: new Prisma.Decimal(data.minQuantity),
        reorderQuantity: new Prisma.Decimal(data.reorderQuantity),
      },
    });

    await this.auditService.logEvent({
      businessId,
      userId,
      branchId: data.branchId,
      action: 'REORDER_POINT_UPSERT',
      resourceType: 'ReorderPoint',
      resourceId: record.id,
      outcome: 'SUCCESS',
      metadata: data,
    });

    return record;
  }

  async listReorderSuggestions(
    businessId: string,
    query: { branchId?: string },
    branchScope: string[] = [],
  ) {
    const branchFilter = this.resolveBranchScope(branchScope, query.branchId);
    const reorderPoints = await this.prisma.reorderPoint.findMany({
      where: {
        businessId,
        ...branchFilter,
      },
      include: {
        variant: true,
        branch: true,
      },
    });

    if (!reorderPoints.length) {
      return [];
    }

    const snapshots = await this.prisma.stockSnapshot.findMany({
      where: {
        businessId,
        branchId: { in: reorderPoints.map((row) => row.branchId) },
        variantId: { in: reorderPoints.map((row) => row.variantId) },
      },
    });
    const snapshotMap = new Map(
      snapshots.map((row) => [`${row.branchId}:${row.variantId}`, row]),
    );

    return reorderPoints
      .map((row) => {
        const snapshot = snapshotMap.get(`${row.branchId}:${row.variantId}`);
        const onHand = snapshot ? Number(snapshot.quantity) : 0;
        const inTransit = snapshot ? Number(snapshot.inTransitQuantity) : 0;
        const minQuantity = Number(row.minQuantity);
        const reorderQuantity = Number(row.reorderQuantity);
        const deficit = minQuantity - (onHand + inTransit);
        if (deficit <= 0) {
          return null;
        }
        const suggested = Math.max(deficit, reorderQuantity);
        return {
          id: row.id,
          branchId: row.branchId,
          variantId: row.variantId,
          branch: row.branch,
          variant: row.variant,
          onHand,
          inTransit,
          minQuantity,
          reorderQuantity,
          suggestedQuantity: suggested,
        };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
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
