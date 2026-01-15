import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  Prisma,
  OfflineActionStatus,
  OfflineDeviceStatus,
  SubscriptionTier,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { RbacService } from '../rbac/rbac.service';
import { SettingsService } from '../settings/settings.service';
import { SalesService } from '../sales/sales.service';
import { StockService } from '../stock/stock.service';
import { PurchasesService } from '../purchases/purchases.service';
import { DEFAULT_POS_POLICIES } from '../settings/defaults';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';

type OfflineActionInput = {
  actionType: 'SALE_COMPLETE' | 'PURCHASE_DRAFT' | 'STOCK_ADJUSTMENT';
  payload: Record<string, unknown>;
  checksum: string;
  provisionalAt?: string;
  localAuditId?: string;
};

type OfflineConflictResolution =
  | 'DISMISS'
  | 'RETRY'
  | 'OVERRIDE_PRICE'
  | 'SYNC_APPROVAL';

type OfflineActionResult = {
  id: string;
  actionType: string;
  checksum: string;
  localAuditId?: string | null;
  status: OfflineActionStatus;
  result?: Record<string, unknown>;
  conflictReason?: string | null;
  errorMessage?: string | null;
};

@Injectable()
export class OfflineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly subscriptionService: SubscriptionService,
    private readonly rbacService: RbacService,
    private readonly settingsService: SettingsService,
    private readonly salesService: SalesService,
    private readonly stockService: StockService,
    private readonly purchasesService: PurchasesService,
  ) {}

  async registerDevice(
    businessId: string,
    userId: string,
    deviceName: string,
    deviceId?: string,
  ) {
    const subscription =
      await this.subscriptionService.getSubscription(businessId);
    if (!subscription?.limits.offline) {
      throw new ForbiddenException(
        'Offline mode not enabled for this subscription.',
      );
    }
    const membership = await this.prisma.businessUser.findUnique({
      where: { businessId_userId: { businessId, userId } },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      throw new ForbiddenException('User not active for this business.');
    }

    await this.subscriptionService.assertLimit(businessId, 'offlineDevices');

    const access = await this.rbacService.resolveUserAccess(userId, businessId);
    const existing = deviceId
      ? await this.prisma.offlineDevice.findFirst({
          where: { id: deviceId, businessId, userId },
        })
      : null;

    const device = existing
      ? await this.prisma.offlineDevice.update({
          where: { id: existing.id },
          data: {
            deviceName,
            status: OfflineDeviceStatus.ACTIVE,
            revokedAt: null,
            permissionsSnapshot: access as Prisma.InputJsonValue,
          },
        })
      : await this.prisma.offlineDevice.create({
          data: {
            id: deviceId,
            businessId,
            userId,
            deviceName,
            deviceKey: `dev-${Date.now()}`,
            status: OfflineDeviceStatus.ACTIVE,
            permissionsSnapshot: access as Prisma.InputJsonValue,
          },
        });

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'OFFLINE_DEVICE_REGISTER',
      resourceType: 'OfflineDevice',
      resourceId: device.id,
      outcome: 'SUCCESS',
      metadata: { offline: true },
    });

    return device;
  }

  async revokeDevice(businessId: string, userId: string, deviceId: string) {
    const device = await this.prisma.offlineDevice.findFirst({
      where: { id: deviceId, businessId },
    });
    if (!device) {
      throw new BadRequestException('Device not found.');
    }
    const updated = await this.prisma.offlineDevice.update({
      where: { id: deviceId },
      data: { status: OfflineDeviceStatus.REVOKED, revokedAt: new Date() },
    });

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'OFFLINE_DEVICE_REVOKE',
      resourceType: 'OfflineDevice',
      resourceId: deviceId,
      outcome: 'SUCCESS',
      metadata: { offline: true },
    });

    return updated;
  }

  async getStatus(businessId: string, userId: string, deviceId: string) {
    const subscription =
      await this.subscriptionService.getSubscription(businessId);
    const settings = await this.settingsService.getSettings(businessId);
    const device = await this.prisma.offlineDevice.findFirst({
      where: { id: deviceId, businessId, userId },
    });
    const pendingActions = await this.prisma.offlineAction.findMany({
      where: { businessId, deviceId, status: OfflineActionStatus.PENDING },
      select: { actionType: true, payload: true },
    });
    const pendingSales = pendingActions.filter(
      (action) => action.actionType === 'SALE_COMPLETE',
    );
    const pendingSalesValue = pendingSales.reduce((sum, action) => {
      const payload = action.payload as { total?: number };
      return sum + Number(payload?.total ?? 0);
    }, 0);

    return {
      device,
      offlineEnabled: Boolean(subscription?.limits.offline),
      limits: {
        offlineDevices: subscription?.limits.offlineDevices ?? 0,
        offlineLimits: this.resolveOfflineLimits(subscription?.tier, settings),
      },
      pendingCount: pendingActions.length,
      pendingSalesValue,
      lastSeenAt: device?.lastSeenAt ?? device?.createdAt ?? null,
    };
  }

  async getRiskOverview(businessId: string) {
    const subscription =
      await this.subscriptionService.getSubscription(businessId);
    const offlineEnabled = Boolean(subscription?.limits.offline);
    const staleThresholdHours = 2;
    const staleCutoff = new Date(
      Date.now() - staleThresholdHours * 60 * 60 * 1000,
    );

    const [activeDevices, staleDevices, expiredDevices, pendingActions, failedActions, conflictActions] =
      await Promise.all([
        this.prisma.offlineDevice.count({
          where: { businessId, status: OfflineDeviceStatus.ACTIVE },
        }),
        this.prisma.offlineDevice.count({
          where: {
            businessId,
            status: OfflineDeviceStatus.ACTIVE,
            OR: [
              { lastSeenAt: { lte: staleCutoff } },
              { lastSeenAt: null, createdAt: { lte: staleCutoff } },
            ],
          },
        }),
        this.prisma.offlineDevice.count({
          where: { businessId, status: OfflineDeviceStatus.EXPIRED },
        }),
        this.prisma.offlineAction.count({
          where: { businessId, status: OfflineActionStatus.PENDING },
        }),
        this.prisma.offlineAction.count({
          where: { businessId, status: OfflineActionStatus.FAILED },
        }),
        this.prisma.offlineAction.count({
          where: { businessId, status: OfflineActionStatus.CONFLICT },
        }),
      ]);

    let riskScore = 0;
    if (expiredDevices > 0) {
      riskScore += 3;
    }
    if (failedActions > 0) {
      riskScore += 3;
    }
    if (conflictActions > 0) {
      riskScore += 2;
    }
    if (staleDevices > 0) {
      riskScore += 1;
    }
    if (pendingActions > 20) {
      riskScore += 2;
    } else if (pendingActions > 5) {
      riskScore += 1;
    }

    const riskLevel =
      riskScore >= 5 ? 'HIGH' : riskScore >= 3 ? 'MEDIUM' : 'LOW';

    return {
      offlineEnabled,
      riskLevel,
      staleThresholdHours,
      devices: {
        active: activeDevices,
        stale: staleDevices,
        expired: expiredDevices,
      },
      actions: {
        pending: pendingActions,
        failed: failedActions,
        conflicts: conflictActions,
      },
    };
  }

  async listConflicts(
    businessId: string,
    deviceId: string,
    query: PaginationQuery = {},
  ) {
    const pagination = parsePagination(query);
    return this.prisma.offlineAction
      .findMany({
        where: {
          businessId,
          deviceId,
          status: {
            in: [OfflineActionStatus.CONFLICT, OfflineActionStatus.REJECTED],
          },
        },
        orderBy: { createdAt: 'desc' },
        ...pagination,
      })
      .then((items) => buildPaginatedResponse(items, pagination.take));
  }

  async resolveConflict(
    businessId: string,
    userId: string,
    actionId: string,
    resolution: OfflineConflictResolution,
  ) {
    const action = await this.prisma.offlineAction.findFirst({
      where: { id: actionId, businessId },
    });
    if (!action) {
      throw new BadRequestException('Offline action not found.');
    }
    if (action.status === OfflineActionStatus.APPLIED) {
      return action;
    }

    const finalize = async (result: {
      status: OfflineActionStatus;
      conflictReason?: string | null;
      conflictPayload?: Record<string, unknown>;
      errorMessage?: string | null;
    }) => {
      const updated = await this.prisma.offlineAction.update({
        where: { id: actionId },
        data: {
          status: result.status,
          syncedAt: new Date(),
          appliedAt:
            result.status === OfflineActionStatus.APPLIED ? new Date() : null,
          conflictReason: result.conflictReason ?? null,
          conflictPayload: result.conflictPayload
            ? (result.conflictPayload as Prisma.InputJsonValue)
            : Prisma.DbNull,
          errorMessage: result.errorMessage ?? null,
        },
      });
      await this.auditService.logEvent({
        businessId,
        userId,
        action: 'OFFLINE_CONFLICT_RESOLVE',
        resourceType: 'OfflineAction',
        resourceId: actionId,
        outcome: 'SUCCESS',
        metadata: {
          resolution,
          previousStatus: action.status,
          conflictReason: action.conflictReason,
        },
      });
      await this.auditService.logEvent({
        businessId,
        userId,
        action: `OFFLINE_ACTION_${result.status}`,
        resourceType: 'OfflineAction',
        resourceId: actionId,
        outcome:
          result.status === OfflineActionStatus.APPLIED ? 'SUCCESS' : 'FAILURE',
        metadata: {
          actionType: action.actionType,
          conflictReason: result.conflictReason ?? null,
          offline: true,
        },
      });
      return updated;
    };

    if (resolution === 'DISMISS') {
      return finalize({
        status: OfflineActionStatus.REJECTED,
        errorMessage: 'Dismissed by user.',
      });
    }

    const conflictPayload =
      (action.conflictPayload as Record<string, unknown> | null) ?? undefined;
    if (resolution === 'SYNC_APPROVAL') {
      if (action.conflictReason !== 'APPROVAL_REQUIRED') {
        throw new BadRequestException('Approval sync is not applicable.');
      }
      const approvalId =
        conflictPayload && typeof conflictPayload.approvalId === 'string'
          ? conflictPayload.approvalId
          : null;
      if (!approvalId) {
        throw new BadRequestException('Approval reference missing.');
      }
      const approval = await this.prisma.approval.findFirst({
        where: { id: approvalId, businessId },
      });
      if (!approval) {
        throw new BadRequestException('Approval not found.');
      }
      if (approval.status === 'APPROVED') {
        return finalize({
          status: OfflineActionStatus.APPLIED,
          conflictReason: null,
          conflictPayload,
        });
      }
      if (approval.status === 'REJECTED') {
        return finalize({
          status: OfflineActionStatus.REJECTED,
          conflictReason: action.conflictReason,
          conflictPayload,
          errorMessage: 'Approval rejected.',
        });
      }
      return finalize({
        status: OfflineActionStatus.CONFLICT,
        conflictReason: action.conflictReason,
        conflictPayload,
        errorMessage: 'Approval still pending.',
      });
    }

    const access = await this.rbacService.resolveUserAccess(userId, businessId);
    const permissions = access.permissions;
    const roleIds = access.roleIds;
    const requiredPermission = this.getActionPermission(
      action.actionType as OfflineActionInput['actionType'],
    );
    if (requiredPermission && !permissions.includes(requiredPermission)) {
      return finalize({
        status: OfflineActionStatus.REJECTED,
        conflictReason: 'PERMISSION_REVOKED',
        errorMessage: 'Permission revoked for action.',
      });
    }

    let result: {
      status: OfflineActionStatus;
      result?: Record<string, unknown>;
      conflictReason?: string | null;
      conflictPayload?: Record<string, unknown>;
      errorMessage?: string | null;
    };
    const payload = action.payload as Record<string, unknown>;
    if (resolution === 'OVERRIDE_PRICE' && action.actionType !== 'SALE_COMPLETE') {
      throw new BadRequestException('Price override is only available for sales.');
    }
    switch (action.actionType) {
      case 'SALE_COMPLETE':
        result = await this.applySale(
          businessId,
          userId,
          action.deviceId,
          permissions,
          roleIds,
          payload,
          { allowPriceVariance: resolution === 'OVERRIDE_PRICE' },
        );
        break;
      case 'PURCHASE_DRAFT':
        result = await this.applyPurchaseDraft(businessId, userId, payload);
        break;
      case 'STOCK_ADJUSTMENT':
        result = await this.applyStockAdjustment(
          businessId,
          userId,
          roleIds,
          payload,
        );
        break;
      default:
        result = {
          status: OfflineActionStatus.REJECTED,
          errorMessage: 'Unsupported offline action.',
        };
    }

    return finalize({
      status: result.status,
      conflictReason: result.conflictReason ?? null,
      conflictPayload: result.conflictPayload ?? conflictPayload,
      errorMessage: result.errorMessage ?? null,
    });
  }

  async recordStatus(
    businessId: string,
    userId: string,
    deviceId: string,
    status: 'OFFLINE' | 'ONLINE',
    since?: string,
  ) {
    const device = await this.prisma.offlineDevice.findFirst({
      where: { id: deviceId, businessId, userId },
    });
    if (!device) {
      throw new BadRequestException('Device not registered for this user.');
    }
    if (status === 'ONLINE') {
      await this.prisma.offlineDevice.update({
        where: { id: deviceId },
        data: { lastSeenAt: new Date() },
      });
    }
    if (status === 'OFFLINE') {
      const offlineSince = since ? new Date(since) : new Date();
      await this.prisma.offlineDevice.update({
        where: { id: deviceId },
        data: { lastSeenAt: offlineSince },
      });
    }
    await this.auditService.logEvent({
      businessId,
      userId,
      action: status === 'OFFLINE' ? 'OFFLINE_ENTRY' : 'OFFLINE_EXIT',
      resourceType: 'OfflineDevice',
      resourceId: deviceId,
      outcome: 'SUCCESS',
      metadata: { offline: status === 'OFFLINE', since: since ?? null },
    });
    return { ok: true };
  }

  private getActionPermission(actionType: OfflineActionInput['actionType']) {
    switch (actionType) {
      case 'SALE_COMPLETE':
        return 'sales.write';
      case 'STOCK_ADJUSTMENT':
        return 'stock.write';
      case 'PURCHASE_DRAFT':
        return 'purchases.write';
      default:
        return null;
    }
  }

  private async enforceOfflineDuration(
    businessId: string,
    userId: string,
    deviceId: string,
    maxDurationHours: number,
  ) {
    if (maxDurationHours <= 0) {
      return;
    }
    const device = await this.prisma.offlineDevice.findFirst({
      where: { id: deviceId, businessId, userId },
    });
    if (!device) {
      return;
    }
    const lastSeen = device.lastSeenAt ?? device.createdAt;
    const elapsedHours =
      (Date.now() - new Date(lastSeen).getTime()) / (1000 * 60 * 60);
    if (elapsedHours > maxDurationHours) {
      await this.prisma.offlineDevice.update({
        where: { id: deviceId },
        data: { status: OfflineDeviceStatus.EXPIRED },
      });
      await this.auditService.logEvent({
        businessId,
        userId,
        action: 'OFFLINE_DURATION_EXCEEDED',
        resourceType: 'OfflineDevice',
        resourceId: deviceId,
        outcome: 'FAILURE',
        metadata: { elapsedHours, maxDurationHours, offline: true },
      });
      throw new ForbiddenException('Offline session duration exceeded.');
    }
  }

  private async buildOfflineCache(businessId: string, userId: string) {
    const settings = await this.settingsService.getSettings(businessId);
    const stockPolicies = settings?.stockPolicies as {
      batchTrackingEnabled?: boolean;
    };
    const access = await this.rbacService.resolveUserAccess(userId, businessId);
    const [
      branches,
      products,
      variants,
      units,
      barcodes,
      batches,
      snapshots,
      customers,
      priceLists,
      suppliers,
    ] = await Promise.all([
      this.prisma.branch.findMany({
        where: { businessId, status: 'ACTIVE' },
        select: { id: true, name: true, priceListId: true },
      }),
      this.prisma.product.findMany({
        where: { businessId, status: 'ACTIVE' },
        select: { id: true, name: true, categoryId: true },
      }),
      this.prisma.variant.findMany({
        where: { businessId, status: 'ACTIVE' },
        select: {
          id: true,
          productId: true,
          name: true,
          sku: true,
          defaultPrice: true,
          minPrice: true,
          vatMode: true,
          trackStock: true,
          baseUnitId: true,
          sellUnitId: true,
          conversionFactor: true,
        },
      }),
      this.prisma.unit.findMany({
        where: { OR: [{ businessId }, { businessId: null }] },
        select: {
          id: true,
          code: true,
          label: true,
          unitType: true,
          businessId: true,
        },
      }),
      this.prisma.barcode.findMany({
        where: { businessId, isActive: true },
        select: { id: true, variantId: true, code: true, isActive: true },
      }),
      stockPolicies?.batchTrackingEnabled
        ? this.prisma.batch.findMany({
            where: { businessId },
            select: {
              id: true,
              branchId: true,
              variantId: true,
              code: true,
              expiryDate: true,
            },
          })
        : Promise.resolve([]),
      this.prisma.stockSnapshot.findMany({
        where: { businessId },
        select: {
          id: true,
          branchId: true,
          variantId: true,
          quantity: true,
          inTransitQuantity: true,
        },
      }),
      this.prisma.customer.findMany({
        where: { businessId, status: 'ACTIVE' },
        select: { id: true, name: true, priceListId: true },
      }),
      this.prisma.priceList.findMany({
        where: { businessId, status: 'ACTIVE' },
        include: { items: true },
      }),
      this.prisma.supplier.findMany({
        where: { businessId, status: 'ACTIVE' },
        select: { id: true, name: true },
      }),
    ]);
    return {
      branches,
      products,
      variants,
      units,
      barcodes,
      batches,
      stockSnapshots: snapshots,
      customers,
      priceLists,
      suppliers,
      permissions: access,
      settings: {
        posPolicies: settings?.posPolicies,
        stockPolicies: settings?.stockPolicies,
      },
    };
  }

  private resolveOfflineLimits(
    subscriptionTier: SubscriptionTier | undefined,
    settings: { posPolicies?: unknown } | null,
  ) {
    const configured =
      (settings?.posPolicies as { offlineLimits?: Record<string, number> })
        ?.offlineLimits ?? {};
    const defaultsByTier: Record<
      SubscriptionTier,
      { maxDurationHours: number; maxSalesCount: number; maxTotalValue: number }
    > = {
      STARTER: { maxDurationHours: 0, maxSalesCount: 0, maxTotalValue: 0 },
      BUSINESS: {
        maxDurationHours: 72,
        maxSalesCount: 200,
        maxTotalValue: DEFAULT_POS_POLICIES.offlineLimits.maxTotalValue,
      },
      ENTERPRISE: {
        maxDurationHours: 168,
        maxSalesCount: 2000,
        maxTotalValue: DEFAULT_POS_POLICIES.offlineLimits.maxTotalValue,
      },
    };
    const defaults = subscriptionTier
      ? defaultsByTier[subscriptionTier]
      : defaultsByTier.BUSINESS;
    return {
      maxDurationHours:
        configured.maxDurationHours ?? defaults.maxDurationHours,
      maxSalesCount: configured.maxSalesCount ?? defaults.maxSalesCount,
      maxTotalValue: configured.maxTotalValue ?? defaults.maxTotalValue,
    };
  }

  private async applySale(
    businessId: string,
    userId: string,
    deviceId: string,
    permissions: string[],
    roleIds: string[],
    payload: Record<string, unknown>,
    options?: { allowPriceVariance?: boolean },
  ) {
    const branchId = payload.branchId as string;
    const lines = payload.lines as {
      variantId: string;
      quantity: number;
      unitPrice: number;
      vatMode: 'INCLUSIVE' | 'EXCLUSIVE' | 'EXEMPT';
      vatRate: number;
      lineDiscount?: number;
      barcode?: string;
    }[];
    const payments =
      (payload.payments as {
        method: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER' | 'OTHER';
        amount: number;
        reference?: string;
        methodLabel?: string;
      }[]) ?? [];
    const cartDiscount = Number(payload.cartDiscount ?? 0);
    const customerId = payload.customerId as string | undefined;
    const creditDueDate = payload.creditDueDate as string | undefined;

    const settings = await this.settingsService.getSettings(businessId);
    const posPolicies = settings?.posPolicies as {
      offlinePriceVariancePercent?: number;
    };
    const varianceThreshold = posPolicies?.offlinePriceVariancePercent ?? 3;
    const variantIds = lines.map((line) => line.variantId);
    const variants = await this.prisma.variant.findMany({
      where: { businessId, id: { in: variantIds } },
      select: { id: true, defaultPrice: true },
    });
    const priceMap = new Map(
      variants.map((variant) => [
        variant.id,
        Number(variant.defaultPrice ?? 0),
      ]),
    );
    const varianceBreaches = lines
      .map((line) => {
        const current = priceMap.get(line.variantId) ?? 0;
        if (current <= 0) {
          return null;
        }
        const diff = Math.abs(current - line.unitPrice);
        const percent = (diff / current) * 100;
        if (percent > varianceThreshold) {
          return {
            variantId: line.variantId,
            offlinePrice: line.unitPrice,
            currentPrice: current,
            variancePercent: Number(percent.toFixed(2)),
          };
        }
        return null;
      })
      .filter(Boolean);
    if (varianceBreaches.length && !options?.allowPriceVariance) {
      return {
        status: OfflineActionStatus.CONFLICT,
        conflictReason: 'PRICE_VARIANCE',
        conflictPayload: { varianceBreaches, varianceThreshold },
      };
    }

    const draft = await this.salesService.createDraft(
      businessId,
      userId,
      roleIds,
      permissions,
      {
        branchId,
        customerId,
        cartDiscount,
        isOffline: true,
        offlineDeviceId: deviceId,
        lines,
      },
    );
    if (draft && 'approvalRequired' in draft) {
      const saleId =
        (draft as { id?: string; sale?: { id: string } })?.sale?.id ??
        (draft as { id?: string })?.id ??
        null;
      return {
        status: OfflineActionStatus.CONFLICT,
        conflictReason: 'APPROVAL_REQUIRED',
        conflictPayload: { approvalId: draft.approvalId, saleId },
      };
    }
    const saleId =
      (draft as { id?: string; sale?: { id: string } })?.sale?.id ??
      (draft as { id?: string })?.id;
    if (!saleId) {
      return {
        status: OfflineActionStatus.FAILED,
        errorMessage: 'Draft sale creation failed.',
      };
    }

    try {
      const completion = await this.salesService.completeSale(
        businessId,
        saleId,
        userId,
        {
          payments,
          creditDueDate,
          idempotencyKey: payload.idempotencyKey as string,
          userPermissions: permissions,
        },
      );
      if (completion && 'approvalRequired' in completion) {
        return {
          status: OfflineActionStatus.CONFLICT,
          conflictReason: 'APPROVAL_REQUIRED',
          conflictPayload: { approvalId: completion.approvalId, saleId },
        };
      }
      const receiptNumber = (
        completion as { receipt?: { receiptNumber?: string } }
      )?.receipt?.receiptNumber;
      return {
        status: OfflineActionStatus.APPLIED,
        result: { saleId, receiptNumber },
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Sale sync failed.';
      if (message.includes('Insufficient stock')) {
        return {
          status: OfflineActionStatus.REJECTED,
          conflictReason: 'STOCK_OVERSELL',
          errorMessage: message,
        };
      }
      if (message.includes('permission')) {
        return {
          status: OfflineActionStatus.REJECTED,
          conflictReason: 'PERMISSION_REVOKED',
          errorMessage: message,
        };
      }
      if (message.includes('Batch')) {
        return {
          status: OfflineActionStatus.CONFLICT,
          conflictReason: 'BATCH_DEPLETED',
          errorMessage: message,
        };
      }
      return {
        status: OfflineActionStatus.REJECTED,
        errorMessage: message,
      };
    }
  }

  private async applyPurchaseDraft(
    businessId: string,
    userId: string,
    payload: Record<string, unknown>,
  ) {
    const draft = await this.purchasesService.createDraftPurchase(
      businessId,
      userId,
      {
        branchId: payload.branchId as string,
        supplierId: payload.supplierId as string,
        lines: payload.lines as {
          variantId: string;
          quantity: number;
          unitCost: number;
        }[],
        idempotencyKey: payload.idempotencyKey as string | undefined,
      },
    );
    if (!draft) {
      return {
        status: OfflineActionStatus.FAILED,
        errorMessage: 'Draft purchase creation failed.',
      };
    }
    return {
      status: OfflineActionStatus.APPLIED,
      result: { purchaseId: (draft as { id: string }).id },
    };
  }

  private async applyStockAdjustment(
    businessId: string,
    userId: string,
    roleIds: string[],
    payload: Record<string, unknown>,
  ) {
    const adjustment = await this.stockService.createAdjustment(
      businessId,
      userId,
      roleIds,
      {
        branchId: payload.branchId as string,
        variantId: payload.variantId as string,
        quantity: Number(payload.quantity ?? 0),
        reason: payload.reason as string | undefined,
        type: payload.type as 'POSITIVE' | 'NEGATIVE',
        batchId: payload.batchId as string | undefined,
        lossReason: payload.lossReason as any,
        idempotencyKey: payload.idempotencyKey as string | undefined,
      },
    );
    if (adjustment && 'approvalRequired' in adjustment) {
      return {
        status: OfflineActionStatus.CONFLICT,
        conflictReason: 'APPROVAL_REQUIRED',
        conflictPayload: { approvalId: adjustment.approvalId },
      };
    }
    if (adjustment && 'error' in adjustment) {
      return {
        status: OfflineActionStatus.REJECTED,
        errorMessage: adjustment.error,
      };
    }
    if (!adjustment) {
      return {
        status: OfflineActionStatus.FAILED,
        errorMessage: 'Stock adjustment failed.',
      };
    }
    return {
      status: OfflineActionStatus.APPLIED,
      result: { movementId: (adjustment as { id: string }).id },
    };
  }

  async syncActions(
    businessId: string,
    userId: string,
    deviceId: string,
    actions: OfflineActionInput[],
  ) {
    const subscription =
      await this.subscriptionService.getSubscription(businessId);
    if (!subscription?.limits.offline) {
      throw new ForbiddenException(
        'Offline mode not enabled for this subscription.',
      );
    }
    if (
      subscription.status === 'EXPIRED' ||
      subscription.status === 'SUSPENDED'
    ) {
      throw new ForbiddenException(
        'Offline mode is disabled for this subscription.',
      );
    }
    const membership = await this.prisma.businessUser.findUnique({
      where: { businessId_userId: { businessId, userId } },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      throw new ForbiddenException('User not active for this business.');
    }

    const device = await this.prisma.offlineDevice.findFirst({
      where: { id: deviceId, businessId, userId },
    });
    if (!device) {
      throw new ForbiddenException('Device not registered for this user.');
    }
    if (device.status !== OfflineDeviceStatus.ACTIVE) {
      throw new ForbiddenException('Offline device is not active.');
    }

    const settings = await this.settingsService.getSettings(businessId);
    const resolvedLimits = this.resolveOfflineLimits(
      subscription?.tier,
      settings,
    );
    const maxDurationHours = resolvedLimits.maxDurationHours ?? 0;
    const maxSalesCount = resolvedLimits.maxSalesCount ?? 0;
    const maxTotalValue = resolvedLimits.maxTotalValue ?? 0;
    await this.enforceOfflineDuration(
      businessId,
      userId,
      deviceId,
      maxDurationHours,
    );

    const salesActions = actions.filter(
      (action) => action.actionType === 'SALE_COMPLETE',
    );
    const existingPendingSales = await this.prisma.offlineAction.findMany({
      where: {
        businessId,
        deviceId,
        status: OfflineActionStatus.PENDING,
        actionType: 'SALE_COMPLETE',
      },
      select: { payload: true },
    });
    const existingSalesCount = existingPendingSales.length;
    const incomingSalesCount = salesActions.length;
    if (
      maxSalesCount > 0 &&
      existingSalesCount + incomingSalesCount > maxSalesCount
    ) {
      throw new BadRequestException(
        'Offline sale queue exceeds maximum allowed.',
      );
    }
    if (maxTotalValue > 0) {
      const existingTotal = existingPendingSales.reduce((sum, action) => {
        const payload = action.payload as { total?: number | string } | null;
        return sum + Number(payload?.total ?? 0);
      }, 0);
      const incomingTotal = salesActions.reduce((sum, action) => {
        const total = Number(action.payload.total ?? 0);
        return sum + total;
      }, 0);
      if (existingTotal + incomingTotal > maxTotalValue) {
        throw new BadRequestException(
          'Offline sale total exceeds maximum allowed.',
        );
      }
    }

    const access = await this.rbacService.resolveUserAccess(userId, businessId);
    const permissions = access.permissions;
    const roleIds = access.roleIds;

    await this.prisma.offlineDevice.update({
      where: { id: deviceId },
      data: {
        lastSeenAt: new Date(),
        permissionsSnapshot: access as Prisma.InputJsonValue,
      },
    });

    const sortedActions = [...actions].sort((a, b) => {
      const aTime = a.provisionalAt ? new Date(a.provisionalAt).getTime() : 0;
      const bTime = b.provisionalAt ? new Date(b.provisionalAt).getTime() : 0;
      return aTime - bTime;
    });

    const results: OfflineActionResult[] = [];

    for (const action of sortedActions) {
      const requiredPermission = this.getActionPermission(action.actionType);
      if (requiredPermission && !permissions.includes(requiredPermission)) {
        results.push({
          id: 'permission-blocked',
          actionType: action.actionType,
          status: OfflineActionStatus.REJECTED,
          checksum: action.checksum,
          localAuditId: action.localAuditId ?? null,
          conflictReason: 'PERMISSION_REVOKED',
          errorMessage: 'Permission revoked for action.',
        });
        continue;
      }

      let record;
      try {
        record = await this.prisma.offlineAction.create({
          data: {
            businessId,
            userId,
            deviceId,
            actionType: action.actionType,
            payload: action.payload as Prisma.InputJsonValue,
            checksum: action.checksum,
            localAuditId: action.localAuditId ?? null,
            provisionalAt: action.provisionalAt
              ? new Date(action.provisionalAt)
              : null,
          },
        });
        await this.auditService.logEvent({
          businessId,
          userId,
          action: 'OFFLINE_ACTION_INGESTED',
          resourceType: 'OfflineAction',
          resourceId: record.id,
          outcome: 'SUCCESS',
          metadata: {
            actionType: action.actionType,
            localAuditId: action.localAuditId ?? null,
            provisionalAt: action.provisionalAt ?? null,
            offline: true,
          },
        });
      } catch (error) {
        record = await this.prisma.offlineAction.findFirst({
          where: { businessId, deviceId, checksum: action.checksum },
        });
        if (record) {
          results.push({
            id: record.id,
            actionType: record.actionType,
            checksum: record.checksum,
            localAuditId: record.localAuditId ?? null,
            status: record.status,
            conflictReason: record.conflictReason,
            errorMessage: record.errorMessage,
          });
          continue;
        }
        throw error;
      }

      let result: {
        status: OfflineActionStatus;
        result?: Record<string, unknown>;
        conflictReason?: string | null;
        conflictPayload?: Record<string, unknown>;
        errorMessage?: string | null;
      };
      switch (action.actionType) {
        case 'SALE_COMPLETE':
          result = await this.applySale(
            businessId,
            userId,
            deviceId,
            permissions,
            roleIds,
            action.payload,
          );
          break;
        case 'PURCHASE_DRAFT':
          result = await this.applyPurchaseDraft(
            businessId,
            userId,
            action.payload,
          );
          break;
        case 'STOCK_ADJUSTMENT':
          result = await this.applyStockAdjustment(
            businessId,
            userId,
            roleIds,
            action.payload,
          );
          break;
        default:
          result = {
            status: OfflineActionStatus.REJECTED,
            errorMessage: 'Unsupported offline action.',
          };
      }

      await this.prisma.offlineAction.update({
        where: { id: record.id },
        data: {
          status: result.status,
          syncedAt: new Date(),
          appliedAt:
            result.status === OfflineActionStatus.APPLIED ? new Date() : null,
          conflictReason: result.conflictReason ?? null,
          conflictPayload: result.conflictPayload
            ? (result.conflictPayload as Prisma.InputJsonValue)
            : Prisma.DbNull,
          errorMessage: result.errorMessage ?? null,
        },
      });

      await this.auditService.logEvent({
        businessId,
        userId,
        action: `OFFLINE_ACTION_${result.status}`,
        resourceType: 'OfflineAction',
        resourceId: record.id,
        outcome:
          result.status === OfflineActionStatus.APPLIED ? 'SUCCESS' : 'FAILURE',
        metadata: {
          actionType: record.actionType,
          conflictReason: result.conflictReason ?? null,
          offline: true,
        },
      });

      results.push({
        id: record.id,
        actionType: record.actionType,
        checksum: record.checksum,
        localAuditId: record.localAuditId ?? null,
        status: result.status,
        result: result.result,
        conflictReason: result.conflictReason ?? null,
        errorMessage: result.errorMessage ?? null,
      });
    }

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'OFFLINE_SYNC',
      resourceType: 'OfflineAction',
      outcome: 'SUCCESS',
      metadata: { count: actions.length, offline: true },
    });

    const cache = await this.buildOfflineCache(businessId, userId);

    return {
      results,
      cache,
    };
  }
}
