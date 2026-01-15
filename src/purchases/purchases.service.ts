import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  Prisma,
  PurchaseStatus,
  StockMovementType,
  SupplierReturnStatus,
} from '@prisma/client';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuditService } from '../audit/audit.service';
import { AuditEvent } from '../audit/audit.types';
import {
  claimIdempotency,
  clearIdempotency,
  finalizeIdempotency,
} from '../common/idempotency';
import { labelWithFallback } from '../common/labels';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { UnitsService } from '../units/units.service';
import { DEFAULT_STOCK_POLICIES } from '../settings/defaults';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';

@Injectable()
export class PurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly approvalsService: ApprovalsService,
    private readonly notificationsService: NotificationsService,
    private readonly subscriptionService: SubscriptionService,
    private readonly unitsService: UnitsService,
  ) {}

  private async getStockPolicies(businessId: string) {
    const settings = await this.prisma.businessSettings.findUnique({
      where: { businessId },
    });
    const stockPolicies =
      (settings?.stockPolicies as Record<string, unknown> | null) ?? {};
    return {
      ...DEFAULT_STOCK_POLICIES,
      ...stockPolicies,
    } as { negativeStockAllowed?: boolean; batchTrackingEnabled?: boolean };
  }

  private ensureActiveSupplier(supplier: { status?: string | null }) {
    if (supplier.status && supplier.status !== 'ACTIVE') {
      throw new BadRequestException('Supplier is inactive.');
    }
  }

  async listPurchases(
    businessId: string,
    query: PaginationQuery & {
      search?: string;
      status?: string;
      supplierId?: string;
      branchId?: string;
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
    const branchScopeFilter =
      Object.keys(branchFilter).length > 0
        ? {
            OR: [
              { purchase: branchFilter },
              { purchaseOrder: branchFilter },
            ],
          }
        : null;
    const where = {
      businessId,
      ...(query.status ? { status: query.status as PurchaseStatus } : {}),
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...branchFilter,
      ...(search
        ? {
            OR: [
              { id: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { supplier: { name: { contains: search, mode: Prisma.QueryMode.insensitive } } },
              { branch: { name: { contains: search, mode: Prisma.QueryMode.insensitive } } },
            ],
          }
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
    const includeTotal =
      query.includeTotal === 'true' || query.includeTotal === '1';
    return Promise.all([
      this.prisma.purchase.findMany({
        where,
        include: {
          supplier: true,
          branch: true,
          lines: true,
          payments: true,
          attachments: true,
        },
        orderBy: { createdAt: 'desc' },
        ...pagination,
      }),
      includeTotal
        ? this.prisma.purchase.count({ where })
        : Promise.resolve(null),
    ]).then(([items, total]) =>
      buildPaginatedResponse(
        items,
        pagination.take,
        typeof total === 'number' ? total : undefined,
      ),
    );
  }

  async listPurchaseOrders(
    businessId: string,
    query: PaginationQuery & {
      search?: string;
      status?: string;
      supplierId?: string;
      branchId?: string;
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
    const where = {
      businessId,
      ...(query.status ? { status: query.status as any } : {}),
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...branchFilter,
      ...(search
        ? {
            OR: [
              { id: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { supplier: { name: { contains: search, mode: Prisma.QueryMode.insensitive } } },
              { branch: { name: { contains: search, mode: Prisma.QueryMode.insensitive } } },
            ],
          }
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
    const includeTotal =
      query.includeTotal === 'true' || query.includeTotal === '1';
    return Promise.all([
      this.prisma.purchaseOrder.findMany({
        where,
        include: {
          supplier: true,
          branch: true,
          lines: true,
          attachments: true,
        },
        orderBy: { createdAt: 'desc' },
        ...pagination,
      }),
      includeTotal
        ? this.prisma.purchaseOrder.count({ where })
        : Promise.resolve(null),
    ]).then(([items, total]) =>
      buildPaginatedResponse(
        items,
        pagination.take,
        typeof total === 'number' ? total : undefined,
      ),
    );
  }

  async listReceivings(
    businessId: string,
    query: PaginationQuery & {
      search?: string;
      branchId?: string;
      variantId?: string;
      purchaseId?: string;
      purchaseOrderId?: string;
      status?: string;
      from?: string;
      to?: string;
      includeTotal?: string;
    } = {},
    branchScope: string[] = [],
  ) {
    const pagination = parsePagination(query);
    const search = query.search?.trim();
    const status = query.status as PurchaseStatus | undefined;
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    const branchFilter = this.resolveBranchScope(branchScope, query.branchId);
    const branchScopeFilter =
      Object.keys(branchFilter).length > 0
        ? {
            OR: [
              { purchase: branchFilter },
              { purchaseOrder: branchFilter },
            ],
          }
        : null;
    const where = {
      ...(query.variantId ? { variantId: query.variantId } : {}),
      ...(query.purchaseId ? { purchaseId: query.purchaseId } : {}),
      ...(query.purchaseOrderId
        ? { purchaseOrderId: query.purchaseOrderId }
        : {}),
      ...(from || to
        ? {
            receivedAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
      AND: [
        {
          OR: [{ purchase: { businessId } }, { purchaseOrder: { businessId } }],
        },
        ...(branchScopeFilter ? [branchScopeFilter] : []),
        ...(status
          ? [
              {
                OR: [
                  { purchase: { status } },
                  { purchaseOrder: { status } },
                ],
              },
            ]
          : []),
        ...(search
          ? [
              {
                OR: [
                  { id: { contains: search, mode: Prisma.QueryMode.insensitive } },
                  { purchaseId: { contains: search, mode: Prisma.QueryMode.insensitive } },
                  {
                    purchaseOrderId: { contains: search, mode: Prisma.QueryMode.insensitive },
                  },
                  {
                    variant: { name: { contains: search, mode: Prisma.QueryMode.insensitive } },
                  },
                  {
                    variant: { sku: { contains: search, mode: Prisma.QueryMode.insensitive } },
                  },
                  { batch: { code: { contains: search, mode: Prisma.QueryMode.insensitive } } },
                  {
                    purchase: {
                      supplier: {
                        name: { contains: search, mode: Prisma.QueryMode.insensitive },
                      },
                    },
                  },
                  {
                    purchaseOrder: {
                      supplier: {
                        name: { contains: search, mode: Prisma.QueryMode.insensitive },
                      },
                    },
                  },
                ],
              },
            ]
          : []),
      ],
    };
    const includeTotal =
      query.includeTotal === 'true' || query.includeTotal === '1';
    return Promise.all([
      this.prisma.receivingLine.findMany({
        where,
        include: {
          variant: true,
          purchase: { include: { supplier: true } },
          purchaseOrder: { include: { supplier: true } },
          batch: true,
        },
        orderBy: { receivedAt: 'desc' },
        ...pagination,
      }),
      includeTotal
        ? this.prisma.receivingLine.count({ where })
        : Promise.resolve(null),
    ]).then(([items, total]) =>
      buildPaginatedResponse(
        items,
        pagination.take,
        typeof total === 'number' ? total : undefined,
      ),
    );
  }

  async listSupplierReturns(
    businessId: string,
    query: PaginationQuery & {
      search?: string;
      status?: string;
      supplierId?: string;
      branchId?: string;
      from?: string;
      to?: string;
    } = {},
    branchScope: string[] = [],
  ) {
    const pagination = parsePagination(query);
    const search = query.search?.trim();
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    const branchFilter = this.resolveBranchScope(branchScope, query.branchId);
    const normalizedStatus =
      query.status &&
      Object.values(SupplierReturnStatus).includes(
        query.status as SupplierReturnStatus,
      )
        ? (query.status as SupplierReturnStatus)
        : undefined;
    return this.prisma.supplierReturn
      .findMany({
        where: {
          businessId,
          ...(normalizedStatus ? { status: normalizedStatus } : {}),
          ...(query.supplierId ? { supplierId: query.supplierId } : {}),
          ...branchFilter,
          ...(search
            ? {
                OR: [
                  { id: { contains: search, mode: Prisma.QueryMode.insensitive } },
                  {
                    supplier: {
                      name: { contains: search, mode: Prisma.QueryMode.insensitive },
                    },
                  },
                  { branch: { name: { contains: search, mode: Prisma.QueryMode.insensitive } } },
                ],
              }
            : {}),
          ...(from || to
            ? {
                createdAt: {
                  ...(from ? { gte: from } : {}),
                  ...(to ? { lte: to } : {}),
                },
              }
            : {}),
        },
        include: {
          supplier: true,
          branch: true,
          purchase: true,
          purchaseOrder: true,
          lines: { include: { variant: true, receivingLine: true } },
        },
        orderBy: { createdAt: 'desc' },
        ...pagination,
      })
      .then((items) => buildPaginatedResponse(items, pagination.take));
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

  async createPurchase(
    businessId: string,
    userId: string,
    roleIds: string[],
    data: {
      branchId: string;
      supplierId: string;
      lines: {
        variantId: string;
        quantity: number;
        unitCost: number;
        unitId?: string;
      }[];
      idempotencyKey?: string;
    },
  ) {
    const branch = await this.prisma.branch.findFirst({
      where: { id: data.branchId, businessId },
    });
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: data.supplierId, businessId },
    });
    if (!branch || !supplier) {
      return null;
    }
    this.ensureActiveSupplier(supplier);
    const variantIds = data.lines.map((line) => line.variantId);
    const variants = await this.prisma.variant.findMany({
      where: { businessId, id: { in: variantIds } },
      select: { id: true },
    });
    if (variants.length !== variantIds.length) {
      return null;
    }
    const resolvedLines = await Promise.all(
      data.lines.map(async (line) => {
        const unitResolution = await this.unitsService.resolveUnitFactor({
          businessId,
          variantId: line.variantId,
          unitId: line.unitId,
        });
        return {
          ...line,
          unitId: unitResolution.unitId,
          unitFactor: unitResolution.unitFactor,
        };
      }),
    );
    const total = resolvedLines.reduce(
      (sum, line) =>
        sum.plus(new Prisma.Decimal(line.quantity).mul(line.unitCost)),
      new Prisma.Decimal(0),
    );

    await this.subscriptionService.assertLimit(
      businessId,
      'monthlyTransactions',
    );

    const approval = await this.approvalsService.requestApproval({
      businessId,
      actionType: 'PURCHASE_CREATE',
      requestedByUserId: userId,
      requesterRoleIds: roleIds,
      amount: total.toNumber(),
      metadata: data,
      targetType: 'Purchase',
    });

    if (approval.required) {
      return { approvalRequired: true, approvalId: approval.approval?.id };
    }

    const idempotency = await claimIdempotency(
      this.prisma,
      businessId,
      'purchase.create',
      data.idempotencyKey,
    );
    if (idempotency?.existing) {
      if (idempotency.record.resourceId) {
        return this.prisma.purchase.findUnique({
          where: { id: idempotency.record.resourceId },
          include: { lines: true },
        });
      }
      return { error: 'Idempotency key already used.' };
    }

    let purchase;
    try {
      purchase = await this.prisma.purchase.create({
        data: {
          businessId,
          branchId: data.branchId,
          supplierId: data.supplierId,
          status: PurchaseStatus.APPROVED,
          total,
          lines: {
            create: resolvedLines.map((line) => ({
              variantId: line.variantId,
              quantity: new Prisma.Decimal(line.quantity),
              unitCost: new Prisma.Decimal(line.unitCost),
              unitId: line.unitId,
              unitFactor: line.unitFactor,
            })),
          },
        },
        include: { lines: true },
      });
    } catch (error) {
      if (idempotency) {
        await clearIdempotency(this.prisma, idempotency.record.id);
      }
      throw error;
    }

    if (idempotency) {
      await finalizeIdempotency(this.prisma, idempotency.record.id, {
        resourceType: 'Purchase',
        resourceId: purchase.id,
        metadata: { total: total.toNumber() },
      });
    }

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'PURCHASE_CREATE',
      resourceType: 'Purchase',
      resourceId: purchase.id,
      outcome: 'SUCCESS',
      metadata: data,
    });

    await this.notificationsService.notifyEvent({
      businessId,
      eventKey: 'purchaseCreated',
      actorUserId: userId,
      title: 'Purchase created',
      message: `Purchase ${labelWithFallback({ id: purchase.id })} created.`,
      priority: 'INFO',
      metadata: { purchaseId: purchase.id },
      branchId: purchase.branchId,
    });

    return purchase;
  }

  async createDraftPurchase(
    businessId: string,
    userId: string,
    data: {
      branchId: string;
      supplierId: string;
      lines: {
        variantId: string;
        quantity: number;
        unitCost: number;
        unitId?: string;
      }[];
      idempotencyKey?: string;
    },
  ) {
    const branch = await this.prisma.branch.findFirst({
      where: { id: data.branchId, businessId },
    });
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: data.supplierId, businessId },
    });
    if (!branch || !supplier) {
      return null;
    }
    this.ensureActiveSupplier(supplier);
    const variantIds = data.lines.map((line) => line.variantId);
    const variants = await this.prisma.variant.findMany({
      where: { businessId, id: { in: variantIds } },
      select: { id: true },
    });
    if (variants.length !== variantIds.length) {
      return null;
    }

    const resolvedLines = await Promise.all(
      data.lines.map(async (line) => {
        const unitResolution = await this.unitsService.resolveUnitFactor({
          businessId,
          variantId: line.variantId,
          unitId: line.unitId,
        });
        return {
          ...line,
          unitId: unitResolution.unitId,
          unitFactor: unitResolution.unitFactor,
        };
      }),
    );
    const total = resolvedLines.reduce(
      (sum, line) =>
        sum.plus(new Prisma.Decimal(line.quantity).mul(line.unitCost)),
      new Prisma.Decimal(0),
    );

    await this.subscriptionService.assertLimit(
      businessId,
      'monthlyTransactions',
    );

    const idempotency = await claimIdempotency(
      this.prisma,
      businessId,
      'purchase.draft',
      data.idempotencyKey,
    );
    if (idempotency?.existing) {
      if (idempotency.record.resourceId) {
        return this.prisma.purchase.findUnique({
          where: { id: idempotency.record.resourceId },
          include: { lines: true },
        });
      }
      return { error: 'Idempotency key already used.' };
    }

    let purchase;
    try {
      purchase = await this.prisma.purchase.create({
        data: {
          businessId,
          branchId: data.branchId,
          supplierId: data.supplierId,
          status: PurchaseStatus.DRAFT,
          total,
          lines: {
            create: resolvedLines.map((line) => ({
              variantId: line.variantId,
              quantity: new Prisma.Decimal(line.quantity),
              unitCost: new Prisma.Decimal(line.unitCost),
              unitId: line.unitId,
              unitFactor: line.unitFactor,
            })),
          },
        },
        include: { lines: true },
      });
    } catch (error) {
      if (idempotency) {
        await clearIdempotency(this.prisma, idempotency.record.id);
      }
      throw error;
    }

    if (idempotency) {
      await finalizeIdempotency(this.prisma, idempotency.record.id, {
        resourceType: 'Purchase',
        resourceId: purchase.id,
        metadata: { total: total.toNumber(), draft: true },
      });
    }

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'PURCHASE_DRAFT_CREATE',
      resourceType: 'Purchase',
      resourceId: purchase.id,
      outcome: 'SUCCESS',
      metadata: { ...data, offline: true },
    });

    return purchase;
  }

  async createPurchaseOrder(
    businessId: string,
    userId: string,
    data: {
      branchId: string;
      supplierId: string;
      lines: {
        variantId: string;
        quantity: number;
        unitCost: number;
        unitId?: string;
      }[];
      expectedAt?: string;
      idempotencyKey?: string;
    },
  ) {
    if (!Array.isArray(data.lines) || data.lines.length === 0) {
      throw new BadRequestException('Purchase order lines are required.');
    }
    const branch = await this.prisma.branch.findFirst({
      where: { id: data.branchId, businessId },
    });
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: data.supplierId, businessId },
    });
    if (!branch || !supplier) {
      return null;
    }
    this.ensureActiveSupplier(supplier);
    const variantIds = data.lines.map((line) => line.variantId);
    const variants = await this.prisma.variant.findMany({
      where: { businessId, id: { in: variantIds } },
      select: { id: true },
    });
    if (variants.length !== variantIds.length) {
      return null;
    }

    await this.subscriptionService.assertLimit(
      businessId,
      'monthlyTransactions',
    );

    const idempotency = await claimIdempotency(
      this.prisma,
      businessId,
      'purchaseOrder.create',
      data.idempotencyKey,
    );
    if (idempotency?.existing) {
      if (idempotency.record.resourceId) {
        return this.prisma.purchaseOrder.findUnique({
          where: { id: idempotency.record.resourceId },
          include: { lines: true },
        });
      }
      return { error: 'Idempotency key already used.' };
    }

    const resolvedLines = await Promise.all(
      data.lines.map(async (line) => {
        const unitResolution = await this.unitsService.resolveUnitFactor({
          businessId,
          variantId: line.variantId,
          unitId: line.unitId,
        });
        return {
          ...line,
          unitId: unitResolution.unitId,
          unitFactor: unitResolution.unitFactor,
        };
      }),
    );

    const expectedAt = data.expectedAt
      ? new Date(data.expectedAt)
      : supplier.leadTimeDays
        ? new Date(Date.now() + supplier.leadTimeDays * 24 * 60 * 60 * 1000)
        : null;

    let po;
    try {
      po = await this.prisma.purchaseOrder.create({
        data: {
          businessId,
          branchId: data.branchId,
          supplierId: data.supplierId,
          status: PurchaseStatus.DRAFT,
          expectedAt,
          lines: {
            create: resolvedLines.map((line) => ({
              variantId: line.variantId,
              quantity: new Prisma.Decimal(line.quantity),
              unitCost: new Prisma.Decimal(line.unitCost),
              unitId: line.unitId,
              unitFactor: line.unitFactor,
            })),
          },
        },
        include: { lines: true },
      });
    } catch (error) {
      if (idempotency) {
        await clearIdempotency(this.prisma, idempotency.record.id);
      }
      throw error;
    }

    if (idempotency) {
      await finalizeIdempotency(this.prisma, idempotency.record.id, {
        resourceType: 'PurchaseOrder',
        resourceId: po.id,
      });
    }

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'PURCHASE_ORDER_CREATE',
      resourceType: 'PurchaseOrder',
      resourceId: po.id,
      outcome: 'SUCCESS',
      metadata: data,
    });

    await this.notificationsService.notifyEvent({
      businessId,
      eventKey: 'purchaseOrderCreated',
      actorUserId: userId,
      title: 'Purchase order created',
      message: `Purchase order ${labelWithFallback({ id: po.id })} created.`,
      priority: 'INFO',
      metadata: { purchaseOrderId: po.id },
      branchId: po.branchId,
    });

    return po;
  }

  async updatePurchaseOrder(
    businessId: string,
    userId: string,
    roleIds: string[],
    purchaseOrderId: string,
    data: {
      lines: {
        variantId: string;
        quantity: number;
        unitCost: number;
        unitId?: string;
      }[];
      expectedAt?: string | null;
    },
  ) {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id: purchaseOrderId, businessId },
      include: { lines: true },
    });
    if (!po) {
      return null;
    }
    if (po.status === PurchaseStatus.APPROVED) {
      const approval = await this.approvalsService.requestApproval({
        businessId,
        actionType: 'PURCHASE_ORDER_EDIT',
        requestedByUserId: userId,
        requesterRoleIds: roleIds,
        amount: null,
        metadata: { purchaseOrderId, lines: data.lines },
        targetType: 'PurchaseOrder',
        targetId: purchaseOrderId,
      });
      if (approval.required) {
        return { approvalRequired: true, approvalId: approval.approval?.id };
      }
    }

    const variantIds = data.lines.map((line) => line.variantId);
    const variants = await this.prisma.variant.findMany({
      where: { businessId, id: { in: variantIds } },
      select: { id: true },
    });
    if (variants.length !== variantIds.length) {
      return null;
    }

    const resolvedLines = await Promise.all(
      data.lines.map(async (line) => {
        const unitResolution = await this.unitsService.resolveUnitFactor({
          businessId,
          variantId: line.variantId,
          unitId: line.unitId,
        });
        return {
          ...line,
          unitId: unitResolution.unitId,
          unitFactor: unitResolution.unitFactor,
        };
      }),
    );

    const expectedAt =
      data.expectedAt === undefined
        ? undefined
        : data.expectedAt
          ? new Date(data.expectedAt)
          : null;

    const existingLineMap = new Map<string, (typeof po.lines)[number]>();
    for (const line of po.lines) {
      if (existingLineMap.has(line.variantId)) {
        throw new BadRequestException(
          'Purchase order has duplicate variant lines.',
        );
      }
      existingLineMap.set(line.variantId, line);
    }
    const incomingVariants = new Set(
      resolvedLines.map((line) => line.variantId),
    );
    const removedVariants = po.lines.filter(
      (line) => !incomingVariants.has(line.variantId),
    );
    if (removedVariants.length) {
      throw new BadRequestException(
        'Removing purchase order lines is not allowed.',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      for (const line of resolvedLines) {
        const existing = existingLineMap.get(line.variantId);
        if (existing) {
          await tx.purchaseOrderLine.update({
            where: { id: existing.id },
            data: {
              quantity: new Prisma.Decimal(line.quantity),
              unitCost: new Prisma.Decimal(line.unitCost),
              unitId: line.unitId,
              unitFactor: line.unitFactor,
            },
          });
        } else {
          await tx.purchaseOrderLine.create({
            data: {
              purchaseOrderId,
              variantId: line.variantId,
              quantity: new Prisma.Decimal(line.quantity),
              unitCost: new Prisma.Decimal(line.unitCost),
              unitId: line.unitId,
              unitFactor: line.unitFactor,
            },
          });
        }
      }
      return tx.purchaseOrder.update({
        where: { id: purchaseOrderId },
        data: { expectedAt },
        include: { lines: true },
      });
    });

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'PURCHASE_ORDER_UPDATE',
      resourceType: 'PurchaseOrder',
      resourceId: updated.id,
      outcome: 'SUCCESS',
      metadata: data,
    });

    return updated;
  }

  async approvePurchaseOrder(
    businessId: string,
    purchaseOrderId: string,
    userId: string,
    roleIds: string[],
  ) {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id: purchaseOrderId, businessId },
    });
    if (!po) {
      return null;
    }

    const approval = await this.approvalsService.requestApproval({
      businessId,
      actionType: 'PURCHASE_ORDER_APPROVAL',
      requestedByUserId: userId,
      requesterRoleIds: roleIds,
      amount: null,
      metadata: { purchaseOrderId },
      targetType: 'PurchaseOrder',
      targetId: purchaseOrderId,
    });

    if (approval.required) {
      return { approvalRequired: true, approvalId: approval.approval?.id };
    }

    const updated = await this.prisma.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: { status: PurchaseStatus.APPROVED },
    });

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'PURCHASE_ORDER_APPROVE',
      resourceType: 'PurchaseOrder',
      resourceId: updated.id,
      outcome: 'SUCCESS',
    });

    await this.notificationsService.notifyEvent({
      businessId,
      eventKey: 'purchaseOrderApproved',
      actorUserId: userId,
      title: 'Purchase order approved',
      message: `Purchase order ${labelWithFallback({ id: updated.id })} approved.`,
      priority: 'INFO',
      metadata: { purchaseOrderId: updated.id },
      branchId: updated.branchId,
    });

    return updated;
  }

  async receive(
    businessId: string,
    userId: string,
    data: {
      purchaseId?: string;
      purchaseOrderId?: string;
      lines: {
        variantId: string;
        quantity: number;
        unitCost: number;
        unitId?: string;
        batchId?: string;
        batchCode?: string;
        expiryDate?: string;
      }[];
      overrideReason?: string;
      idempotencyKey?: string;
    },
  ) {
    if (!Array.isArray(data.lines) || data.lines.length === 0) {
      throw new BadRequestException(
        'Receiving must include at least one line.',
      );
    }
    const purchaseBranch = data.purchaseId
      ? await this.prisma.purchase.findFirst({
          where: { id: data.purchaseId, businessId },
          select: { branchId: true },
        })
      : null;
    const poBranch = data.purchaseOrderId
      ? await this.prisma.purchaseOrder.findFirst({
          where: { id: data.purchaseOrderId, businessId },
          select: { branchId: true, status: true },
        })
      : null;
    if (data.purchaseId) {
      if (!purchaseBranch) {
        return null;
      }
    }
    if (data.purchaseOrderId) {
      if (!poBranch) {
        return null;
      }
      if (
        poBranch.status !== PurchaseStatus.APPROVED &&
        poBranch.status !== PurchaseStatus.PARTIALLY_RECEIVED
      ) {
        throw new BadRequestException(
          'Purchase order not approved for receiving.',
        );
      }
    }
    const stockPolicies = await this.getStockPolicies(businessId);
    const batchTrackingEnabled = !!stockPolicies.batchTrackingEnabled;
    const branchId = purchaseBranch?.branchId ?? poBranch?.branchId ?? '';

    const resolvedLines = await Promise.all(
      data.lines.map(async (line) => {
        const unitResolution = await this.unitsService.resolveUnitFactor({
          businessId,
          variantId: line.variantId,
          unitId: line.unitId,
        });
        const quantity = new Prisma.Decimal(line.quantity);
        const baseQuantity = quantity.mul(unitResolution.unitFactor);
        return {
          ...line,
          unitId: unitResolution.unitId,
          unitFactor: unitResolution.unitFactor,
          baseQuantity,
        };
      }),
    );
    const variantIds = resolvedLines.map((line) => line.variantId);
    const variants = await this.prisma.variant.findMany({
      where: { businessId, id: { in: variantIds } },
      select: { id: true },
    });
    if (variants.length !== variantIds.length) {
      return null;
    }
    const idempotency = await claimIdempotency(
      this.prisma,
      businessId,
      'receiving.create',
      data.idempotencyKey,
    );
    if (idempotency?.existing) {
      const metadata = await this.prisma.idempotencyKey.findUnique({
        where: { id: idempotency.record.id },
        select: { metadata: true },
      });
      const storedCount =
        typeof metadata?.metadata === 'object' &&
        metadata?.metadata !== null &&
        'count' in metadata.metadata
          ? Number((metadata.metadata as { count?: number }).count ?? 0)
          : 0;
      return { count: storedCount };
    }

    let receiving;
    const batchAuditEvents: AuditEvent[] = [];
    const movementAuditEvents: AuditEvent[] = [];
    const snapshotAuditEvents: AuditEvent[] = [];
    try {
      receiving = await this.prisma.$transaction(
        async (tx) => {
          const overrideReason = data.overrideReason?.trim() ?? null;
          const poLines = data.purchaseOrderId
            ? await tx.purchaseOrderLine.findMany({
                where: { purchaseOrderId: data.purchaseOrderId },
              })
            : [];
          const receivedLines = data.purchaseOrderId
            ? await tx.receivingLine.findMany({
                where: { purchaseOrderId: data.purchaseOrderId },
                select: { variantId: true, quantity: true, unitFactor: true },
              })
            : [];
          const receivedMap = new Map<string, Prisma.Decimal>();
          receivedLines.forEach((row) => {
            const factor = row.unitFactor ?? new Prisma.Decimal(1);
            const base = row.quantity.mul(factor);
            const current =
              receivedMap.get(row.variantId) ?? new Prisma.Decimal(0);
            receivedMap.set(row.variantId, current.plus(base));
          });
          const poLineMap = new Map(
            poLines.map((line) => [line.variantId, line]),
          );

          if (data.purchaseOrderId) {
            for (const line of resolvedLines) {
              const poLine = poLineMap.get(line.variantId);
              if (!poLine) {
                throw new BadRequestException('Variant not on purchase order.');
              }
              const received = receivedMap.get(line.variantId);
              const receivedQty = received ? Number(received) : 0;
              const poUnitFactor = poLine.unitFactor ?? new Prisma.Decimal(1);
              const orderedBase = Number(poLine.quantity.mul(poUnitFactor));
              const remaining = orderedBase - receivedQty;
              const incomingBase = Number(line.baseQuantity);
              if (
                incomingBase > remaining ||
                Number(line.unitCost) !== Number(poLine.unitCost) ||
                (line.unitId && poLine.unitId && line.unitId !== poLine.unitId)
              ) {
                if (!overrideReason) {
                  throw new BadRequestException(
                    'Receiving override requires a reason.',
                  );
                }
              }
            }
          }

          const resolvedWithBatch = await Promise.all(
            resolvedLines.map(async (line) => {
              if (!batchTrackingEnabled) {
                return { ...line, batchId: null };
              }
              if (!branchId) {
                throw new BadRequestException(
                  'Branch is required for batch tracking.',
                );
              }
              if (line.batchId) {
                const batch = await tx.batch.findFirst({
                  where: {
                    id: line.batchId,
                    businessId,
                    branchId,
                    variantId: line.variantId,
                  },
                });
                if (!batch) {
                  throw new BadRequestException(
                    'Batch not found for receiving line.',
                  );
                }
                if (!batch.unitCost) {
                  const beforeBatch = { ...batch };
                  const updatedBatch = await tx.batch.update({
                    where: { id: batch.id },
                    data: { unitCost: new Prisma.Decimal(line.unitCost) },
                  });
                  batchAuditEvents.push({
                    businessId,
                    userId,
                    action: 'BATCH_UPDATE',
                    resourceType: 'Batch',
                    resourceId: updatedBatch.id,
                    outcome: 'SUCCESS',
                    metadata: {
                      branchId,
                      variantId: line.variantId,
                      purchaseId: data.purchaseId ?? null,
                      purchaseOrderId: data.purchaseOrderId ?? null,
                    },
                    before: beforeBatch as unknown as Record<string, unknown>,
                    after: updatedBatch as unknown as Record<string, unknown>,
                  });
                }
                return { ...line, batchId: batch.id };
              }

              const code = line.batchCode?.trim();
              if (!code) {
                throw new BadRequestException(
                  'Batch code is required for receiving.',
                );
              }
              const existing = await tx.batch.findFirst({
                where: {
                  businessId,
                  branchId,
                  variantId: line.variantId,
                  code,
                },
              });
              if (existing) {
                if (!existing.unitCost || line.expiryDate) {
                  const beforeBatch = { ...existing };
                  const updatedBatch = await tx.batch.update({
                    where: { id: existing.id },
                    data: {
                      unitCost:
                        existing.unitCost ?? new Prisma.Decimal(line.unitCost),
                      expiryDate: line.expiryDate
                        ? new Date(line.expiryDate)
                        : existing.expiryDate,
                    },
                  });
                  batchAuditEvents.push({
                    businessId,
                    userId,
                    action: 'BATCH_UPDATE',
                    resourceType: 'Batch',
                    resourceId: updatedBatch.id,
                    outcome: 'SUCCESS',
                    metadata: {
                      branchId,
                      variantId: line.variantId,
                      purchaseId: data.purchaseId ?? null,
                      purchaseOrderId: data.purchaseOrderId ?? null,
                    },
                    before: beforeBatch as unknown as Record<string, unknown>,
                    after: updatedBatch as unknown as Record<string, unknown>,
                  });
                }
                return { ...line, batchId: existing.id };
              }
              const createdBatch = await tx.batch.create({
                data: {
                  businessId,
                  branchId,
                  variantId: line.variantId,
                  code,
                  expiryDate: line.expiryDate
                    ? new Date(line.expiryDate)
                    : null,
                  unitCost: new Prisma.Decimal(line.unitCost),
                },
              });
              batchAuditEvents.push({
                businessId,
                userId,
                action: 'BATCH_CREATE',
                resourceType: 'Batch',
                resourceId: createdBatch.id,
                outcome: 'SUCCESS',
                metadata: {
                  branchId,
                  variantId: line.variantId,
                  purchaseId: data.purchaseId ?? null,
                  purchaseOrderId: data.purchaseOrderId ?? null,
                },
                after: createdBatch as unknown as Record<string, unknown>,
              });
              return { ...line, batchId: createdBatch.id };
            }),
          );

          const created = await tx.receivingLine.createMany({
            data: resolvedWithBatch.map((line) => ({
              purchaseId: data.purchaseId,
              purchaseOrderId: data.purchaseOrderId,
              variantId: line.variantId,
              batchId: line.batchId ?? null,
              quantity: new Prisma.Decimal(line.quantity),
              unitCost: new Prisma.Decimal(line.unitCost),
              unitId: line.unitId,
              unitFactor: line.unitFactor,
              overrideReason: overrideReason ?? null,
            })),
          });

          for (const line of resolvedWithBatch) {
            const movement = await tx.stockMovement.create({
              data: {
                businessId,
                branchId: purchaseBranch?.branchId ?? poBranch?.branchId ?? '',
                variantId: line.variantId,
                createdById: userId,
                batchId: line.batchId ?? null,
                quantity: line.baseQuantity,
                unitId: line.unitId,
                unitQuantity: new Prisma.Decimal(line.quantity),
                movementType: StockMovementType.PURCHASE_IN,
              },
            });
            movementAuditEvents.push({
              businessId,
              userId,
              action: 'STOCK_MOVEMENT_CREATE',
              resourceType: 'StockMovement',
              resourceId: movement.id,
              outcome: 'SUCCESS',
              metadata: {
                branchId:
                  purchaseBranch?.branchId ?? poBranch?.branchId ?? null,
                variantId: line.variantId,
                batchId: line.batchId ?? null,
                purchaseId: data.purchaseId ?? null,
                purchaseOrderId: data.purchaseOrderId ?? null,
                movementType: movement.movementType,
              },
              after: movement as unknown as Record<string, unknown>,
            });

            const snapshotBranchId =
              purchaseBranch?.branchId ?? poBranch?.branchId;
            if (snapshotBranchId) {
              const beforeSnapshot = await tx.stockSnapshot.findFirst({
                where: {
                  businessId,
                  branchId: snapshotBranchId,
                  variantId: line.variantId,
                },
              });
              const afterSnapshot = await tx.stockSnapshot.upsert({
                where: {
                  businessId_branchId_variantId: {
                    businessId,
                    branchId: snapshotBranchId,
                    variantId: line.variantId,
                  },
                },
                create: {
                  businessId,
                  branchId: snapshotBranchId,
                  variantId: line.variantId,
                  quantity: line.baseQuantity,
                },
                update: {
                  quantity: { increment: line.baseQuantity },
                },
              });
              snapshotAuditEvents.push({
                businessId,
                userId,
                action: 'STOCK_SNAPSHOT_UPDATE',
                resourceType: 'StockSnapshot',
                resourceId: afterSnapshot.id,
                outcome: 'SUCCESS',
                metadata: {
                  branchId: snapshotBranchId,
                  variantId: line.variantId,
                  batchId: line.batchId ?? null,
                  purchaseId: data.purchaseId ?? null,
                  purchaseOrderId: data.purchaseOrderId ?? null,
                  movementId: movement.id,
                  movementType: movement.movementType,
                },
                before: beforeSnapshot as unknown as Record<string, unknown>,
                after: afterSnapshot as unknown as Record<string, unknown>,
              });
            }
          }

          if (data.purchaseId) {
            const purchase = await tx.purchase.findUnique({
              where: { id: data.purchaseId },
              include: { lines: true, receivings: true },
            });
            if (purchase) {
              const orderedTotal = purchase.lines.reduce((sum, line) => {
                const factor = line.unitFactor ?? new Prisma.Decimal(1);
                return sum + Number(line.quantity.mul(factor));
              }, 0);
              const receivedTotal = purchase.receivings.reduce((sum, line) => {
                const factor = line.unitFactor ?? new Prisma.Decimal(1);
                return sum + Number(line.quantity.mul(factor));
              }, 0);
              const nextStatus =
                receivedTotal >= orderedTotal
                  ? PurchaseStatus.FULLY_RECEIVED
                  : PurchaseStatus.PARTIALLY_RECEIVED;
              await tx.purchase.update({
                where: { id: purchase.id },
                data: { status: nextStatus },
              });
            }
          }

          if (data.purchaseOrderId) {
            const po = await tx.purchaseOrder.findUnique({
              where: { id: data.purchaseOrderId },
              include: { lines: true, receivings: true },
            });
            if (po) {
              const orderedTotal = po.lines.reduce((sum, line) => {
                const factor = line.unitFactor ?? new Prisma.Decimal(1);
                return sum + Number(line.quantity.mul(factor));
              }, 0);
              const receivedTotal = po.receivings.reduce((sum, line) => {
                const factor = line.unitFactor ?? new Prisma.Decimal(1);
                return sum + Number(line.quantity.mul(factor));
              }, 0);
              const nextStatus =
                receivedTotal >= orderedTotal
                  ? PurchaseStatus.FULLY_RECEIVED
                  : PurchaseStatus.PARTIALLY_RECEIVED;
              await tx.purchaseOrder.update({
                where: { id: po.id },
                data: { status: nextStatus },
              });
            }
          }

          return created;
        },
        { timeout: 10000 },
      );
    } catch (error) {
      if (idempotency) {
        await clearIdempotency(this.prisma, idempotency.record.id);
      }
      throw error;
    }

    if (idempotency) {
      await finalizeIdempotency(this.prisma, idempotency.record.id, {
        resourceType: 'Receiving',
        resourceId: null,
        metadata: {
          resourceName: `Receiving (${receiving.count})`,
          count: receiving.count,
          purchaseId: data.purchaseId ?? null,
          purchaseOrderId: data.purchaseOrderId ?? null,
        },
      });
    }

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'RECEIVE_STOCK',
      resourceType: 'ReceivingLine',
      outcome: 'SUCCESS',
      metadata: {
        ...data,
        resourceName: `Receiving (${receiving.count} lines)`,
        count: receiving.count,
      },
    });
    for (const event of batchAuditEvents) {
      await this.auditService.logEvent(event);
    }
    for (const event of movementAuditEvents) {
      await this.auditService.logEvent(event);
    }
    for (const event of snapshotAuditEvents) {
      await this.auditService.logEvent(event);
    }

    const receivingBranchId =
      purchaseBranch?.branchId ?? poBranch?.branchId ?? null;
    await this.notificationsService.notifyEvent({
      businessId,
      eventKey: 'receivingRecorded',
      actorUserId: userId,
      title: 'Receiving recorded',
      message: 'Stock receiving recorded.',
      priority: 'INFO',
      metadata: {
        purchaseId: data.purchaseId,
        purchaseOrderId: data.purchaseOrderId,
      },
      branchId: receivingBranchId ?? undefined,
    });

    return receiving;
  }

  async recordPayment(
    businessId: string,
    userId: string,
    data: {
      purchaseId: string;
      method: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER' | 'OTHER';
      amount: number;
      reference?: string;
      methodLabel?: string;
    },
  ) {
    const purchase = await this.prisma.purchase.findFirst({
      where: { id: data.purchaseId, businessId },
    });
    if (!purchase) {
      return null;
    }
    if (data.method === 'BANK_TRANSFER' && !data.reference) {
      return { error: 'Bank transfer reference is required.' };
    }
    const payment = await this.prisma.purchasePayment.create({
      data: {
        businessId,
        purchaseId: data.purchaseId,
        method: data.method,
        amount: new Prisma.Decimal(data.amount),
        reference: data.reference ?? null,
        methodLabel: data.methodLabel ?? null,
        receivedById: userId,
      },
    });
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'PURCHASE_PAYMENT',
      resourceType: 'PurchasePayment',
      resourceId: payment.id,
      outcome: 'SUCCESS',
      metadata: data,
    });
    return payment;
  }

  async createSupplierReturn(
    businessId: string,
    userId: string,
    roleIds: string[],
    data: {
      branchId: string;
      supplierId: string;
      purchaseId?: string;
      purchaseOrderId?: string;
      reason?: string;
      lines: {
        variantId: string;
        quantity: number;
        unitCost: number;
        unitId?: string;
        receivingLineId?: string;
      }[];
    },
  ) {
    if (!data.lines.length) {
      return { error: 'Return must include at least one line.' };
    }
    const branch = await this.prisma.branch.findFirst({
      where: { id: data.branchId, businessId },
    });
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: data.supplierId, businessId },
    });
    if (!branch || !supplier) {
      return null;
    }
    this.ensureActiveSupplier(supplier);

    const manualReturn = data.lines.some((line) => !line.receivingLineId);
    if (manualReturn && !data.reason?.trim()) {
      throw new BadRequestException(
        'Manual supplier returns require a reason.',
      );
    }

    const approval = await this.approvalsService.requestApproval({
      businessId,
      actionType: 'SUPPLIER_RETURN',
      requestedByUserId: userId,
      requesterRoleIds: roleIds,
      amount: null,
      metadata: data,
      targetType: 'SupplierReturn',
    });
    if (approval.required) {
      return { approvalRequired: true, approvalId: approval.approval?.id };
    }

    const stockPolicies = await this.getStockPolicies(businessId);

    const movementAuditEvents: AuditEvent[] = [];
    const snapshotAuditEvents: AuditEvent[] = [];
    const result = await this.prisma.$transaction(
      async (tx) => {
        const resolvedLines: Array<{
          variantId: string;
          quantity: number;
          unitCost: number;
          unitId?: string | null;
          receivingLineId?: string;
          unitFactor: Prisma.Decimal;
        }> = [];
        for (const line of data.lines) {
          if (line.receivingLineId) {
            const receiving = await tx.receivingLine.findFirst({
              where: { id: line.receivingLineId },
              include: { purchase: true, purchaseOrder: true },
            });
            if (!receiving) {
              throw new BadRequestException('Receiving line not found.');
            }
            if (
              (data.purchaseId && receiving.purchaseId !== data.purchaseId) ||
              (data.purchaseOrderId &&
                receiving.purchaseOrderId !== data.purchaseOrderId)
            ) {
              throw new BadRequestException(
                'Receiving line does not match return source.',
              );
            }
            resolvedLines.push({
              ...line,
              unitId: line.unitId ?? receiving.unitId,
              unitFactor: receiving.unitFactor ?? new Prisma.Decimal(1),
            });
            continue;
          }
          const unitResolution = await this.unitsService.resolveUnitFactor({
            businessId,
            variantId: line.variantId,
            unitId: line.unitId,
          });
          resolvedLines.push({
            ...line,
            unitId: unitResolution.unitId,
            unitFactor: unitResolution.unitFactor,
          });
        }
        const supplierReturn = await tx.supplierReturn.create({
          data: {
            businessId,
            branchId: data.branchId,
            supplierId: data.supplierId,
            purchaseId: data.purchaseId ?? null,
            purchaseOrderId: data.purchaseOrderId ?? null,
            status: SupplierReturnStatus.COMPLETED,
            reason: data.reason ?? null,
            lines: {
              create: resolvedLines.map((line) => ({
                variantId: line.variantId,
                quantity: new Prisma.Decimal(line.quantity),
                unitCost: new Prisma.Decimal(line.unitCost),
                unitId: line.unitId ?? null,
                unitFactor: line.unitFactor,
                receivingLineId: line.receivingLineId ?? null,
              })),
            },
          },
          include: { lines: true },
        });

        for (const line of supplierReturn.lines) {
          const unitFactor = line.unitFactor ?? new Prisma.Decimal(1);
          const baseQuantity = line.quantity.mul(unitFactor);
          if (!stockPolicies.negativeStockAllowed) {
            const snapshot = await tx.stockSnapshot.findFirst({
              where: {
                businessId,
                branchId: data.branchId,
                variantId: line.variantId,
              },
            });
            const current = snapshot ? Number(snapshot.quantity) : 0;
            if (current - Number(baseQuantity) < 0) {
              throw new BadRequestException(
                'Insufficient stock for supplier return.',
              );
            }
          }

          const movement = await tx.stockMovement.create({
            data: {
              businessId,
              branchId: data.branchId,
              variantId: line.variantId,
              createdById: userId,
              quantity: baseQuantity,
              unitId: line.unitId ?? null,
              unitQuantity: line.quantity,
              movementType: StockMovementType.RETURN_OUT,
            },
          });
          movementAuditEvents.push({
            businessId,
            userId,
            action: 'STOCK_MOVEMENT_CREATE',
            resourceType: 'StockMovement',
            resourceId: movement.id,
            outcome: 'SUCCESS',
            metadata: {
              branchId: data.branchId,
              variantId: line.variantId,
              purchaseId: data.purchaseId ?? null,
              purchaseOrderId: data.purchaseOrderId ?? null,
              movementType: movement.movementType,
            },
            after: movement as unknown as Record<string, unknown>,
          });

          const beforeSnapshot = await tx.stockSnapshot.findFirst({
            where: {
              businessId,
              branchId: data.branchId,
              variantId: line.variantId,
            },
          });
          const afterSnapshot = await tx.stockSnapshot.upsert({
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
              quantity: baseQuantity.negated(),
            },
            update: {
              quantity: { decrement: baseQuantity },
            },
          });
          snapshotAuditEvents.push({
            businessId,
            userId,
            action: 'STOCK_SNAPSHOT_UPDATE',
            resourceType: 'StockSnapshot',
            resourceId: afterSnapshot.id,
            outcome: 'SUCCESS',
            metadata: {
              branchId: data.branchId,
              variantId: line.variantId,
              purchaseId: data.purchaseId ?? null,
              purchaseOrderId: data.purchaseOrderId ?? null,
              movementId: movement.id,
              movementType: movement.movementType,
            },
            before: beforeSnapshot as unknown as Record<string, unknown>,
            after: afterSnapshot as unknown as Record<string, unknown>,
          });
        }

        return supplierReturn;
      },
      { timeout: 10000 },
    );

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'SUPPLIER_RETURN',
      resourceType: 'SupplierReturn',
      resourceId: result.id,
      outcome: 'SUCCESS',
      metadata: data,
    });
    for (const event of movementAuditEvents) {
      await this.auditService.logEvent(event);
    }
    for (const event of snapshotAuditEvents) {
      await this.auditService.logEvent(event);
    }

    await this.notificationsService.notifyEvent({
      businessId,
      eventKey: 'supplierReturnRecorded',
      actorUserId: userId,
      title: 'Supplier return recorded',
      message: `Supplier return ${labelWithFallback({ id: result.id })} recorded.`,
      priority: 'WARNING',
      metadata: { supplierReturnId: result.id },
      branchId: data.branchId,
    });

    return result;
  }
}
