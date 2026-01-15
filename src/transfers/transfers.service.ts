import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, StockMovementType, TransferStatus } from '@prisma/client';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuditService } from '../audit/audit.service';
import {
  claimIdempotency,
  clearIdempotency,
  finalizeIdempotency,
} from '../common/idempotency';
import { labelWithFallback } from '../common/labels';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';

@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly approvalsService: ApprovalsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private async getStockPolicies(businessId: string) {
    const settings = await this.prisma.businessSettings.findUnique({
      where: { businessId },
    });
    return (settings?.stockPolicies ?? {}) as {
      negativeStockAllowed?: boolean;
      fifoMode?: string;
      expiryPolicy?: 'ALLOW' | 'WARN' | 'BLOCK';
      batchTrackingEnabled?: boolean;
      transferBatchPolicy?: 'PRESERVE' | 'RECREATE';
    };
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

  private async getCurrency(businessId: string) {
    const settings = await this.prisma.businessSettings.findUnique({
      where: { businessId },
      select: { localeSettings: true },
    });
    const locale =
      (settings?.localeSettings as Record<string, unknown> | null) ?? {};
    return String(locale.currency ?? 'TZS');
  }

  private async maybeCreateTransferExpense(
    transfer: {
      id: string;
      feeAmount: Prisma.Decimal | null;
      feeCurrency: string | null;
      sourceBranchId: string;
      businessId: string;
    },
    userId: string,
  ) {
    if (!transfer.feeAmount || Number(transfer.feeAmount) <= 0) {
      return null;
    }
    const currency =
      (transfer.feeCurrency ?? '').trim().toUpperCase() ||
      (await this.getCurrency(transfer.businessId));
    const expense = await this.prisma.expense.create({
      data: {
        businessId: transfer.businessId,
        branchId: transfer.sourceBranchId,
        category: 'TRANSFER_FEE',
        amount: transfer.feeAmount,
        currency,
        note: `Transfer fee for ${transfer.id}`,
        transferId: transfer.id,
        createdBy: userId,
      },
    });
    await this.auditService.logEvent({
      businessId: transfer.businessId,
      userId,
      action: 'EXPENSE_CREATE',
      resourceType: 'Expense',
      resourceId: expense.id,
      outcome: 'SUCCESS',
      metadata: {
        resourceName: `Transfer fee for ${transfer.id}`,
        transferId: transfer.id,
        amount: transfer.feeAmount,
        currency,
      },
      after: expense as unknown as Record<string, unknown>,
    });
    return expense;
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

  list(
    businessId: string,
    query: PaginationQuery & {
      status?: string;
      sourceBranchId?: string;
      destinationBranchId?: string;
      from?: string;
      to?: string;
      includeTotal?: string;
    } = {},
    branchScope: string[] = [],
  ) {
    const pagination = parsePagination(query);
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    const scopedFilter = this.resolveTransferScope(
      branchScope,
      query.sourceBranchId,
      query.destinationBranchId,
    );
    const where = {
      businessId,
      ...(query.status ? { status: query.status as TransferStatus } : {}),
      ...(query.sourceBranchId ? { sourceBranchId: query.sourceBranchId } : {}),
      ...(query.destinationBranchId
        ? { destinationBranchId: query.destinationBranchId }
        : {}),
      ...(scopedFilter ?? {}),
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
      this.prisma.transfer.findMany({
        where,
        include: {
          sourceBranch: true,
          destinationBranch: true,
          items: {
            include: {
              variant: true,
              batch: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        ...pagination,
      }),
      includeTotal
        ? this.prisma.transfer.count({ where })
        : Promise.resolve(null),
    ]).then(([items, total]) =>
      buildPaginatedResponse(
        items,
        pagination.take,
        typeof total === 'number' ? total : undefined,
      ),
    );
  }

  listPending(
    businessId: string,
    query: PaginationQuery & {
      sourceBranchId?: string;
      destinationBranchId?: string;
      includeTotal?: string;
    } = {},
    branchScope: string[] = [],
  ) {
    const pagination = parsePagination(query);
    const scopedFilter = this.resolveTransferScope(
      branchScope,
      query.sourceBranchId,
      query.destinationBranchId,
    );
    const where = {
      businessId,
      status: {
        in: [
          TransferStatus.REQUESTED,
          TransferStatus.APPROVED,
          TransferStatus.IN_TRANSIT,
        ],
      },
      ...(query.sourceBranchId ? { sourceBranchId: query.sourceBranchId } : {}),
      ...(query.destinationBranchId
        ? { destinationBranchId: query.destinationBranchId }
        : {}),
      ...(scopedFilter ?? {}),
    };
    const includeTotal =
      query.includeTotal === 'true' || query.includeTotal === '1';
    return Promise.all([
      this.prisma.transfer.findMany({
        where,
        select: {
          id: true,
          status: true,
          createdAt: true,
          sourceBranch: { select: { id: true, name: true } },
          destinationBranch: { select: { id: true, name: true } },
          _count: { select: { items: true } },
        },
        orderBy: { createdAt: 'desc' },
        ...pagination,
      }),
      includeTotal
        ? this.prisma.transfer.count({ where })
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
    data: {
      sourceBranchId: string;
      destinationBranchId: string;
      items: { variantId: string; quantity: number; batchId?: string }[];
      feeAmount?: number;
      feeCurrency?: string;
      feeCarrier?: string;
      feeNote?: string;
      idempotencyKey?: string;
    },
  ) {
    const [source, destination] = await Promise.all([
      this.prisma.branch.findFirst({
        where: { id: data.sourceBranchId, businessId },
      }),
      this.prisma.branch.findFirst({
        where: { id: data.destinationBranchId, businessId },
      }),
    ]);
    if (!source || !destination) {
      return null;
    }

    const variantIds = data.items.map((item) => item.variantId);
    const variants = await this.prisma.variant.findMany({
      where: { businessId, id: { in: variantIds } },
      select: { id: true, trackStock: true },
    });
    if (variants.length !== variantIds.length) {
      return null;
    }
    if (variants.some((variant) => !variant.trackStock)) {
      return null;
    }

    const policies = await this.getStockPolicies(businessId);

    for (const item of data.items) {
      const available = await this.ensureVariantAvailable(
        businessId,
        data.sourceBranchId,
        item.variantId,
      );
      if (!available) {
        return null;
      }
      if (policies.batchTrackingEnabled && item.batchId) {
        const batch = await this.prisma.batch.findUnique({
          where: { id: item.batchId },
        });
        if (
          !batch ||
          batch.businessId !== businessId ||
          batch.branchId !== data.sourceBranchId ||
          batch.variantId !== item.variantId
        ) {
          return { error: 'Batch does not match source branch/variant.' };
        }
      }
      if (!policies.negativeStockAllowed) {
        const snapshot = await this.prisma.stockSnapshot.findFirst({
          where: {
            businessId,
            branchId: data.sourceBranchId,
            variantId: item.variantId,
          },
        });
        const current = snapshot ? Number(snapshot.quantity) : 0;
        if (current - item.quantity < 0) {
          return { error: 'Insufficient stock for transfer.' };
        }
      }
    }

    const idempotency = await claimIdempotency(
      this.prisma,
      businessId,
      'transfer.create',
      data.idempotencyKey,
    );
    if (idempotency?.existing) {
      if (idempotency.record.resourceId) {
        return this.prisma.transfer.findUnique({
          where: { id: idempotency.record.resourceId },
          include: { items: true },
        });
      }
      return { error: 'Idempotency key already used.' };
    }

    let transfer;
    try {
      transfer = await this.prisma.transfer.create({
        data: {
          businessId,
          sourceBranchId: data.sourceBranchId,
          destinationBranchId: data.destinationBranchId,
          feeAmount:
            data.feeAmount !== undefined && data.feeAmount !== null
              ? new Prisma.Decimal(data.feeAmount)
              : null,
          feeCurrency: data.feeCurrency?.trim().toUpperCase() ?? null,
          feeCarrier: data.feeCarrier?.trim() ?? null,
          feeNote: data.feeNote?.trim() ?? null,
          items: {
            create: data.items.map((item) => ({
              variantId: item.variantId,
              quantity: new Prisma.Decimal(item.quantity),
              batchId: item.batchId ?? null,
            })),
          },
        },
        include: { items: true },
      });
    } catch (error) {
      if (idempotency) {
        await clearIdempotency(this.prisma, idempotency.record.id);
      }
      throw error;
    }

    if (idempotency) {
      await finalizeIdempotency(this.prisma, idempotency.record.id, {
        resourceType: 'Transfer',
        resourceId: transfer.id,
      });
    }

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'TRANSFER_CREATE',
      resourceType: 'Transfer',
      resourceId: transfer.id,
      outcome: 'SUCCESS',
      metadata: data,
    });

    await this.notificationsService.notifyEvent({
      businessId,
      eventKey: 'transferCreated',
      actorUserId: userId,
      title: 'Transfer created',
      message: `Transfer ${labelWithFallback({ id: transfer.id })} created.`,
      priority: 'INFO',
      metadata: { transferId: transfer.id },
      branchIds: [transfer.sourceBranchId, transfer.destinationBranchId],
    });

    return transfer;
  }

  async approve(
    businessId: string,
    transferId: string,
    userId: string,
    roleIds: string[],
    branchScope: string[] = [],
  ) {
    const transfer = await this.prisma.transfer.findFirst({
      where: { id: transferId, businessId },
    });
    if (!transfer) {
      return null;
    }
    this.ensureTransferScope(transfer, branchScope, 'source');
    if (transfer.status !== TransferStatus.REQUESTED) {
      return transfer;
    }

    const approval = await this.approvalsService.requestApproval({
      businessId,
      actionType: 'TRANSFER_APPROVAL',
      requestedByUserId: userId,
      requesterRoleIds: roleIds,
      metadata: { transferId },
      targetType: 'Transfer',
      targetId: transferId,
    });

    if (approval.required) {
      return { approvalRequired: true, approvalId: approval.approval?.id };
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const refreshed = await tx.transfer.update({
        where: { id: transferId },
        data: { status: TransferStatus.IN_TRANSIT },
        include: { items: true },
      });

      for (const item of refreshed.items) {
        const quantity = new Prisma.Decimal(item.quantity);
        await tx.stockMovement.create({
          data: {
            businessId: refreshed.businessId,
            branchId: refreshed.sourceBranchId,
            variantId: item.variantId,
            createdById: userId,
            quantity,
            movementType: StockMovementType.TRANSFER_OUT,
            batchId: item.batchId ?? null,
          },
        });

        await tx.stockSnapshot.upsert({
          where: {
            businessId_branchId_variantId: {
              businessId: refreshed.businessId,
              branchId: refreshed.sourceBranchId,
              variantId: item.variantId,
            },
          },
          create: {
            businessId: refreshed.businessId,
            branchId: refreshed.sourceBranchId,
            variantId: item.variantId,
            quantity: quantity.negated(),
            inTransitQuantity: new Prisma.Decimal(0),
          },
          update: {
            quantity: {
              decrement: quantity,
            },
          },
        });

        await tx.stockSnapshot.upsert({
          where: {
            businessId_branchId_variantId: {
              businessId: refreshed.businessId,
              branchId: refreshed.destinationBranchId,
              variantId: item.variantId,
            },
          },
          create: {
            businessId: refreshed.businessId,
            branchId: refreshed.destinationBranchId,
            variantId: item.variantId,
            quantity: new Prisma.Decimal(0),
            inTransitQuantity: quantity,
          },
          update: {
            inTransitQuantity: {
              increment: quantity,
            },
          },
        });
      }

      return refreshed;
    });

    await this.maybeCreateTransferExpense(
      {
        id: updated.id,
        feeAmount: updated.feeAmount,
        feeCurrency: updated.feeCurrency,
        sourceBranchId: updated.sourceBranchId,
        businessId,
      },
      userId,
    );

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'TRANSFER_APPROVE',
      resourceType: 'Transfer',
      resourceId: updated.id,
      outcome: 'SUCCESS',
    });

    await this.notificationsService.notifyEvent({
      businessId,
      eventKey: 'transferInTransit',
      actorUserId: userId,
      title: 'Transfer in transit',
      message: `Transfer ${labelWithFallback({ id: updated.id })} is now in transit.`,
      priority: 'INFO',
      metadata: { transferId: updated.id },
      branchIds: [updated.sourceBranchId, updated.destinationBranchId],
    });

    return updated;
  }

  async receive(
    businessId: string,
    transferId: string,
    userId: string,
    items?: { transferItemId: string; quantity: number }[],
    idempotencyKey?: string,
    branchScope: string[] = [],
  ) {
    const idempotency = await claimIdempotency(
      this.prisma,
      businessId,
      `transfer.receive:${transferId}`,
      idempotencyKey,
    );
    if (idempotency?.existing) {
      return this.prisma.transfer.findUnique({
        where: { id: transferId },
        include: { items: true },
      });
    }

    const transfer = await this.prisma.transfer.findUnique({
      where: { id: transferId },
      include: { items: true },
    });

    if (!transfer || transfer.businessId !== businessId) {
      if (idempotency) {
        await clearIdempotency(this.prisma, idempotency.record.id);
      }
      return null;
    }
    this.ensureTransferScope(transfer, branchScope, 'destination');
    if (transfer.status === TransferStatus.REQUESTED) {
      return { error: 'Transfer must be approved before receiving.' };
    }
    if (
      transfer.status === TransferStatus.CANCELLED ||
      transfer.status === TransferStatus.COMPLETED
    ) {
      return { error: 'Transfer is already closed.' };
    }

    const policies = await this.getStockPolicies(businessId);
    const batchTracking = !!policies.batchTrackingEnabled;
    const transferBatchPolicy = policies.transferBatchPolicy ?? 'PRESERVE';
    const expiryPolicy = policies.expiryPolicy ?? 'WARN';

    const receivedMap = new Map<string, number>();
    if (items) {
      for (const item of items) {
        receivedMap.set(item.transferItemId, item.quantity);
      }
    }

    for (const item of transfer.items) {
      const alreadyReceived = Number(item.receivedQuantity ?? 0);
      const remaining = Number(item.quantity) - alreadyReceived;
      const requested = receivedMap.has(item.id)
        ? (receivedMap.get(item.id) ?? 0)
        : remaining;

      if (requested <= 0) {
        continue;
      }
      if (requested > remaining) {
        return { error: 'Received quantity exceeds remaining quantity.' };
      }

      const quantity = new Prisma.Decimal(requested);
      const sourceBatchId = item.batchId ?? null;
      let destinationBatchId = sourceBatchId;

      if (batchTracking && sourceBatchId) {
        const expiryCheck = await this.ensureExpiryPolicy(
          expiryPolicy,
          sourceBatchId,
        );
        if (!expiryCheck.allowed) {
          return { error: expiryCheck.reason };
        }
        const sourceBatch = await this.prisma.batch.findUnique({
          where: { id: sourceBatchId },
        });
        if (sourceBatch) {
          if (transferBatchPolicy === 'RECREATE') {
            const newCode = `${sourceBatch.code}-T${Date.now()}`;
            const destBatch = await this.prisma.batch.create({
              data: {
                businessId,
                branchId: transfer.destinationBranchId,
                variantId: item.variantId,
                code: newCode,
                expiryDate: sourceBatch.expiryDate,
              },
            });
            destinationBatchId = destBatch.id;
            await this.auditService.logEvent({
              businessId,
              userId,
              action: 'BATCH_CREATE',
              resourceType: 'Batch',
              resourceId: destBatch.id,
              outcome: 'SUCCESS',
              metadata: {
                resourceName: destBatch.code,
                transferId,
                variantId: item.variantId,
                branchId: transfer.destinationBranchId,
              },
              after: destBatch as unknown as Record<string, unknown>,
            });
          } else {
            const existing = await this.prisma.batch.findFirst({
              where: {
                businessId,
                branchId: transfer.destinationBranchId,
                variantId: item.variantId,
                code: sourceBatch.code,
              },
            });
            if (existing) {
              destinationBatchId = existing.id;
            } else {
              const destBatch = await this.prisma.batch.create({
                data: {
                  businessId,
                  branchId: transfer.destinationBranchId,
                  variantId: item.variantId,
                  code: sourceBatch.code,
                  expiryDate: sourceBatch.expiryDate,
                },
              });
              destinationBatchId = destBatch.id;
              await this.auditService.logEvent({
                businessId,
                userId,
                action: 'BATCH_CREATE',
                resourceType: 'Batch',
                resourceId: destBatch.id,
                outcome: 'SUCCESS',
                metadata: {
                  resourceName: destBatch.code,
                  transferId,
                  variantId: item.variantId,
                  branchId: transfer.destinationBranchId,
                },
                after: destBatch as unknown as Record<string, unknown>,
              });
            }
          }
        }
      }

      const movement = await this.prisma.stockMovement.create({
        data: {
          businessId: transfer.businessId,
          branchId: transfer.destinationBranchId,
          variantId: item.variantId,
          createdById: userId,
          quantity,
          movementType: StockMovementType.TRANSFER_IN,
          batchId: destinationBatchId,
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
          transferId,
          variantId: item.variantId,
          branchId: transfer.destinationBranchId,
          batchId: destinationBatchId,
          quantity: Number(quantity),
          movementType: StockMovementType.TRANSFER_IN,
        },
        after: movement as unknown as Record<string, unknown>,
      });

      const snapshot = await this.prisma.stockSnapshot.upsert({
        where: {
          businessId_branchId_variantId: {
            businessId: transfer.businessId,
            branchId: transfer.destinationBranchId,
            variantId: item.variantId,
          },
        },
        create: {
          businessId: transfer.businessId,
          branchId: transfer.destinationBranchId,
          variantId: item.variantId,
          quantity,
          inTransitQuantity: new Prisma.Decimal(0),
        },
        update: {
          quantity: {
            increment: quantity,
          },
          inTransitQuantity: {
            decrement: quantity,
          },
        },
      });
      await this.auditService.logEvent({
        businessId,
        userId,
        action: 'STOCK_SNAPSHOT_UPDATE',
        resourceType: 'StockSnapshot',
        resourceId: snapshot.id,
        outcome: 'SUCCESS',
        metadata: {
          transferId,
          variantId: item.variantId,
          branchId: transfer.destinationBranchId,
        },
        after: snapshot as unknown as Record<string, unknown>,
      });

      await this.prisma.transferItem.update({
        where: { id: item.id },
        data: {
          receivedQuantity: {
            increment: quantity,
          },
        },
      });
    }

    let refreshed;
    try {
      refreshed = await this.prisma.transfer.findUnique({
        where: { id: transferId },
        include: { items: true },
      });
    } catch (error) {
      if (idempotency) {
        await clearIdempotency(this.prisma, idempotency.record.id);
      }
      throw error;
    }

    const allReceived =
      refreshed?.items.every(
        (item) => Number(item.receivedQuantity) >= Number(item.quantity),
      ) ?? false;

    const updated = await this.prisma.transfer.update({
      where: { id: transferId },
      data: {
        status: allReceived
          ? TransferStatus.COMPLETED
          : TransferStatus.IN_TRANSIT,
      },
    });

    if (idempotency) {
      await finalizeIdempotency(this.prisma, idempotency.record.id, {
        resourceType: 'Transfer',
        resourceId: updated.id,
        metadata: { status: updated.status },
      });
    }

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'TRANSFER_RECEIVE',
      resourceType: 'Transfer',
      resourceId: transfer.id,
      outcome: 'SUCCESS',
    });

    await this.notificationsService.notifyEvent({
      businessId,
      eventKey: 'transferReceived',
      actorUserId: userId,
      title: 'Transfer received',
      message: allReceived
        ? `Transfer ${transfer.id} marked as received.`
        : `Transfer ${transfer.id} partially received.`,
      priority: 'INFO',
      metadata: { transferId: transfer.id },
      branchIds: [transfer.sourceBranchId, transfer.destinationBranchId],
    });

    return updated;
  }

  async cancel(
    businessId: string,
    transferId: string,
    userId: string,
    branchScope: string[] = [],
  ) {
    const transfer = await this.prisma.transfer.findFirst({
      where: { id: transferId, businessId },
      include: { items: true },
    });
    if (!transfer) {
      return null;
    }
    this.ensureTransferScope(transfer, branchScope, 'either');

    const updated = await this.prisma.$transaction(async (tx) => {
      if (
        transfer.status === TransferStatus.IN_TRANSIT ||
        transfer.status === TransferStatus.APPROVED
      ) {
        for (const item of transfer.items) {
          const remaining =
            Number(item.quantity) - Number(item.receivedQuantity ?? 0);
          if (remaining <= 0) {
            continue;
          }
          const quantity = new Prisma.Decimal(remaining);

          await tx.stockSnapshot.upsert({
            where: {
              businessId_branchId_variantId: {
                businessId: transfer.businessId,
                branchId: transfer.sourceBranchId,
                variantId: item.variantId,
              },
            },
            create: {
              businessId: transfer.businessId,
              branchId: transfer.sourceBranchId,
              variantId: item.variantId,
              quantity,
              inTransitQuantity: new Prisma.Decimal(0),
            },
            update: {
              quantity: {
                increment: quantity,
              },
            },
          });

          await tx.stockSnapshot.upsert({
            where: {
              businessId_branchId_variantId: {
                businessId: transfer.businessId,
                branchId: transfer.destinationBranchId,
                variantId: item.variantId,
              },
            },
            create: {
              businessId: transfer.businessId,
              branchId: transfer.destinationBranchId,
              variantId: item.variantId,
              quantity: new Prisma.Decimal(0),
              inTransitQuantity: new Prisma.Decimal(0),
            },
            update: {
              inTransitQuantity: {
                decrement: quantity,
              },
            },
          });
        }
      }

      return tx.transfer.update({
        where: { id: transferId },
        data: { status: TransferStatus.CANCELLED },
      });
    });

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'TRANSFER_CANCEL',
      resourceType: 'Transfer',
      resourceId: updated.id,
      outcome: 'SUCCESS',
    });

    await this.notificationsService.notifyEvent({
      businessId,
      eventKey: 'transferCancelled',
      actorUserId: userId,
      title: 'Transfer cancelled',
      message: `Transfer ${labelWithFallback({ id: updated.id })} cancelled.`,
      priority: 'WARNING',
      metadata: { transferId: updated.id },
      branchIds: [transfer.sourceBranchId, transfer.destinationBranchId],
    });

    return updated;
  }

  private resolveTransferScope(
    branchScope: string[],
    sourceBranchId?: string,
    destinationBranchId?: string,
  ) {
    if (!branchScope.length) {
      return null;
    }
    if (sourceBranchId && !branchScope.includes(sourceBranchId)) {
      throw new ForbiddenException('Branch-scoped role restriction.');
    }
    if (destinationBranchId && !branchScope.includes(destinationBranchId)) {
      throw new ForbiddenException('Branch-scoped role restriction.');
    }
    return {
      OR: [
        { sourceBranchId: { in: branchScope } },
        { destinationBranchId: { in: branchScope } },
      ],
    };
  }

  private ensureTransferScope(
    transfer: { sourceBranchId: string; destinationBranchId: string },
    branchScope: string[],
    mode: 'source' | 'destination' | 'either',
  ) {
    if (!branchScope.length) {
      return;
    }
    const sourceAllowed = branchScope.includes(transfer.sourceBranchId);
    const destinationAllowed = branchScope.includes(
      transfer.destinationBranchId,
    );
    const allowed =
      mode === 'source'
        ? sourceAllowed
        : mode === 'destination'
          ? destinationAllowed
          : sourceAllowed || destinationAllowed;
    if (!allowed) {
      throw new ForbiddenException('Branch-scoped role restriction.');
    }
  }
}
