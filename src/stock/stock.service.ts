import { ForbiddenException, Injectable, Inject, forwardRef } from '@nestjs/common';
import { LossReason, Prisma, StockMovementType } from '@prisma/client';
import { ApprovalsService } from '../approvals/approvals.service';
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
      ...(query.categoryId ? { product: { categoryId: query.categoryId } } : {}),
      ...(search ? { name: { contains: search, mode: Prisma.QueryMode.insensitive } } : {}),
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
          variant: { include: { baseUnit: true, sellUnit: true } },
        },
        orderBy: { updatedAt: 'desc' },
        ...pagination,
      }),
      includeTotal
        ? this.prisma.stockSnapshot.count({ where })
        : Promise.resolve(null),
    ]);
    return buildPaginatedResponse(
      items,
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
      actorId?: string;
      from?: string;
      to?: string;
      search?: string;
      reason?: string;
    },
    branchScope: string[] = [],
  ) {
    const pagination = parsePagination(query);
    const search = query.search?.trim();
    const reason = query.reason?.trim();
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    const branchFilter = this.resolveBranchScope(branchScope, query.branchId);
    const items = await this.prisma.stockMovement.findMany({
      where: {
        businessId,
        ...branchFilter,
        ...(query.variantId ? { variantId: query.variantId } : {}),
        ...(query.type ? { movementType: query.type } : {}),
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
                { reason: { contains: search, mode: Prisma.QueryMode.insensitive } },
                {
                  variant: { name: { contains: search, mode: Prisma.QueryMode.insensitive } },
                },
              ],
            }
          : {}),
      },
      include: {
        branch: true,
        variant: {
          include: { baseUnit: true, sellUnit: true, product: { select: { name: true } } },
        },
        createdBy: { select: { id: true, name: true, email: true } },
        batch: true,
      },
      orderBy: { createdAt: 'desc' },
      ...pagination,
    });
    return buildPaginatedResponse(items, pagination.take);
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
        ...(search ? { code: { contains: search, mode: Prisma.QueryMode.insensitive } } : {}),
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
    batchId?: string | null,
  ) {
    if (!batchId || policy === 'ALLOW') {
      return { allowed: true };
    }
    const batch = await this.prisma.batch.findUnique({
      where: { id: batchId },
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
      return { error: 'Loss reason is required for negative adjustments.' };
    }

    if (policies.batchTrackingEnabled) {
      if (data.batchId) {
        const batch = await this.prisma.batch.findUnique({
          where: { id: data.batchId },
        });
        if (!batch || batch.businessId !== businessId) {
          return { error: 'Batch not found.' };
        }
      }
      const expiryCheck = await this.ensureExpiryPolicy(
        policies.expiryPolicy ?? 'WARN',
        data.batchId,
      );
      if (!expiryCheck.allowed) {
        return { error: expiryCheck.reason };
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

    if (data.type === 'NEGATIVE' && !policies.negativeStockAllowed) {
      const snapshot = await this.prisma.stockSnapshot.findFirst({
        where: {
          businessId,
          branchId: data.branchId,
          variantId: data.variantId,
        },
      });
      const current = snapshot ? Number(snapshot.quantity) : 0;
      if (current - Number(baseQuantity) < 0) {
        return { error: 'Negative stock is not allowed.' };
      }
    }

    const approvalPayload = {
      branchId: data.branchId,
      variantId: data.variantId,
      quantity: data.quantity,
      unitId: unitResolution.unitId,
      reason: data.reason,
      type: data.type,
      batchId: data.batchId,
      lossReason: data.lossReason,
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
      return { error: 'Idempotency key already used.' };
    }

    const movementType =
      data.type === 'POSITIVE'
        ? StockMovementType.ADJUSTMENT_POSITIVE
        : StockMovementType.ADJUSTMENT_NEGATIVE;

    const quantity = baseQuantity;

    let movement;
    let lossEntryId: string | null = null;
    const beforeSnapshot = await this.prisma.stockSnapshot.findFirst({
      where: {
        businessId,
        branchId: data.branchId,
        variantId: data.variantId,
      },
    });
    let afterSnapshot: typeof beforeSnapshot | null = null;
    try {
      movement = await this.prisma.stockMovement.create({
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
        },
      });

      if (data.type === 'NEGATIVE' && data.lossReason) {
        const unitCost =
          (await this.resolveUnitCost(
            businessId,
            data.branchId,
            data.variantId,
            data.batchId ?? null,
            policies.valuationMethod,
          )) ?? new Prisma.Decimal(variant.defaultCost ?? 0);
        const totalCost = unitCost.mul(quantity);
        const lossEntry = await this.prisma.lossEntry.create({
          data: {
            businessId,
            branchId: data.branchId,
            variantId: data.variantId,
            stockMovementId: movement.id,
            quantity,
            unitCost,
            totalCost,
            reason: data.lossReason,
            note: data.reason ?? null,
          },
        });
        lossEntryId = lossEntry.id;
      }

      const snapshot = await this.prisma.stockSnapshot.upsert({
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
            increment: data.type === 'POSITIVE' ? quantity : quantity.negated(),
          },
        },
      });
      afterSnapshot = snapshot;
      await this.maybeNotifyLowStock(
        businessId,
        data.branchId,
        data.variantId,
        snapshot.quantity,
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
      action: 'STOCK_ADJUST',
      resourceType: 'StockMovement',
      resourceId: movement.id,
      outcome: 'SUCCESS',
      reason: data.reason ?? undefined,
      metadata: {
        ...data,
        lossEntryId,
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
      return { error: 'Counted quantity cannot be negative.' };
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
          return { error: 'Batch not found.' };
        }
      }
      const expiryCheck = await this.ensureExpiryPolicy(
        policies.expiryPolicy ?? 'WARN',
        data.batchId,
      );
      if (!expiryCheck.allowed) {
        return { error: expiryCheck.reason };
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
    const beforeSnapshot = snapshot;

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
      return { error: 'Idempotency key already used.' };
    }

    const variance = Number(baseCountedQuantity) - expectedQuantity;
    const varianceQuantity = new Prisma.Decimal(Math.abs(variance));
    const movementType = StockMovementType.STOCK_COUNT_VARIANCE;

    let movement;
    let afterSnapshot: typeof beforeSnapshot | null = null;
    try {
      movement = await this.prisma.stockMovement.create({
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
        },
      });

      const snapshot = await this.prisma.stockSnapshot.upsert({
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
      afterSnapshot = snapshot;
      await this.maybeNotifyLowStock(
        businessId,
        data.branchId,
        data.variantId,
        snapshot.quantity,
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
      action: 'STOCK_COUNT',
      resourceType: 'StockMovement',
      resourceId: movement.id,
      outcome: 'SUCCESS',
      reason: data.reason ?? undefined,
      metadata: {
        ...data,
        expectedQuantity,
        variance: Number(baseCountedQuantity) - expectedQuantity,
      },
    });
    if (afterSnapshot) {
      await this.auditService.logEvent({
        businessId,
        userId,
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

  async createBatch(
    businessId: string,
    userId: string,
    data: {
      branchId: string;
      variantId: string;
      code: string;
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
      return { error: 'Batch tracking is disabled.' };
    }

    const batch = await this.prisma.batch.create({
      data: {
        businessId,
        branchId: data.branchId,
        variantId: data.variantId,
        code: data.code,
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
