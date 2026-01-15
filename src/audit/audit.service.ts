import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditEvent } from './audit.types';
import { AuditContextStore } from './audit-context';
import { resolveResourceName } from '../common/resource-labels';

const HIGH_RISK_ACTIONS = new Set([
  'STOCK_ADJUST',
  'STOCK_COUNT',
  'SALE_REFUND',
  'APPROVAL_REQUEST',
  'APPROVAL_SELF_APPROVE',
  'APPROVAL_APPROVE',
  'APPROVAL_REJECT',
  'ROLE_CREATE',
  'ROLE_UPDATE',
  'ROLE_PERMISSIONS_UPDATE',
  'USER_ROLE_ASSIGN',
  'USER_ROLE_REMOVE',
]);

const SNAPSHOT_EXCLUDED_ACTIONS = new Set([
  'PERMISSION_CHECK',
  'SUBSCRIPTION_CHECK',
  'AUTH_REFRESH',
  'AUTH_REFRESH_REUSE',
]);

const REPORT_ACTION_PREFIX = 'REPORT_';
const EXPORT_ACTION_PREFIX = 'EXPORT_';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

async function fetchSnapshot(
  prisma: PrismaService,
  params: {
    businessId: string;
    resourceType?: string | null;
    resourceId?: string | null;
  },
) {
  const resourceType = params.resourceType?.trim();
  const resourceId = params.resourceId?.trim();
  if (!resourceType || !resourceId) {
    return null;
  }
  switch (resourceType) {
    case 'Product':
      return prisma.product.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { id: true, name: true, status: true, categoryId: true },
      });
    case 'Variant':
      return prisma.variant.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: {
          id: true,
          name: true,
          productId: true,
          sku: true,
          status: true,
        },
      });
    case 'Category':
      return prisma.category.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { id: true, name: true, status: true },
      });
    case 'Customer':
      return prisma.customer.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          status: true,
        },
      });
    case 'Supplier':
      return prisma.supplier.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          status: true,
        },
      });
    case 'Branch':
      return prisma.branch.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { id: true, name: true, status: true },
      });
    case 'Role':
      return prisma.role.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { id: true, name: true },
      });
    case 'User':
      return prisma.user.findFirst({
        where: { id: resourceId },
        select: { id: true, name: true, email: true, status: true },
      });
    case 'Approval':
      return prisma.approval.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: {
          id: true,
          actionType: true,
          status: true,
          targetType: true,
          targetId: true,
        },
      });
    case 'ApprovalPolicy':
      return prisma.approvalPolicy.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: {
          id: true,
          actionType: true,
          thresholdType: true,
          thresholdValue: true,
          status: true,
        },
      });
    case 'StockMovement':
      return prisma.stockMovement.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: {
          id: true,
          variantId: true,
          branchId: true,
          quantity: true,
          reason: true,
          movementType: true,
        },
      });
    case 'Transfer':
      return prisma.transfer.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: {
          id: true,
          status: true,
          sourceBranchId: true,
          destinationBranchId: true,
        },
      });
    case 'Purchase':
      return prisma.purchase.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { id: true, status: true, supplierId: true, total: true },
      });
    case 'PurchaseOrder':
      return prisma.purchaseOrder.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { id: true, status: true, supplierId: true },
      });
    case 'Sale':
      return prisma.sale.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { id: true, status: true, total: true, branchId: true },
      });
    case 'SaleRefund':
      return prisma.saleRefund.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { id: true, status: true, total: true, saleId: true },
      });
    case 'Expense':
      return prisma.expense.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: {
          id: true,
          category: true,
          amount: true,
          currency: true,
          branchId: true,
        },
      });
    case 'Batch':
      return prisma.batch.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: {
          id: true,
          code: true,
          variantId: true,
          branchId: true,
          expiryDate: true,
        },
      });
    case 'Barcode':
      return prisma.barcode.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { id: true, code: true, variantId: true },
      });
    case 'PriceList':
      return prisma.priceList.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { id: true, name: true, status: true },
      });
    case 'PriceListItem':
      return prisma.priceListItem.findFirst({
        where: { id: resourceId, priceList: { businessId: params.businessId } },
        select: { id: true, priceListId: true, variantId: true, price: true },
      });
    case 'Shift':
      return prisma.shift.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: {
          id: true,
          status: true,
          branchId: true,
          openedAt: true,
          closedAt: true,
        },
      });
    case 'Subscription':
      return prisma.subscription.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { id: true, tier: true, status: true },
      });
    case 'SubscriptionRequest':
      return prisma.subscriptionRequest.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { id: true, type: true, requestedTier: true, status: true },
      });
    case 'SupportAccessRequest':
      return prisma.supportAccessRequest.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { id: true, status: true, reason: true },
      });
    case 'SupplierReturn':
      return prisma.supplierReturn.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: {
          id: true,
          status: true,
          supplierId: true,
          purchaseId: true,
          purchaseOrderId: true,
        },
      });
    case 'Attachment':
      return prisma.attachment.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { id: true, filename: true, url: true },
      });
    case 'OfflineDevice':
      return prisma.offlineDevice.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { id: true, deviceName: true, status: true, userId: true },
      });
    case 'OfflineAction':
      return prisma.offlineAction.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { id: true, actionType: true, status: true, deviceId: true },
      });
    case 'ReceivingLine':
      return prisma.receivingLine.findFirst({
        where: { id: resourceId, variant: { businessId: params.businessId } },
        select: { id: true, quantity: true, variantId: true, purchaseId: true },
      });
    case 'ReorderPoint':
      return prisma.reorderPoint.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: {
          id: true,
          branchId: true,
          variantId: true,
          minQuantity: true,
          reorderQuantity: true,
        },
      });
    case 'Business':
      return prisma.business.findFirst({
        where: { id: resourceId },
        select: { id: true, name: true, status: true },
      });
    case 'BusinessSettings':
      return prisma.businessSettings.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { id: true },
      });
    case 'Receipt':
      return prisma.receipt.findFirst({
        where: { id: resourceId },
        select: { id: true, receiptNumber: true },
      });
    default:
      return null;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const entries = keys.map((key) => {
      const item = value[key];
      return `${JSON.stringify(key)}:${stableStringify(item)}`;
    });
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function computeDiff(
  before?: Record<string, unknown> | null,
  after?: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  if (!before && !after) {
    return undefined;
  }
  const beforeValue = before ?? {};
  const afterValue = after ?? {};
  if (!isPlainObject(beforeValue) || !isPlainObject(afterValue)) {
    return { from: beforeValue ?? null, to: afterValue ?? null };
  }
  const keys = new Set([
    ...Object.keys(beforeValue),
    ...Object.keys(afterValue),
  ]);
  const diff: Record<string, unknown> = {};
  for (const key of keys) {
    const fromValue = beforeValue[key];
    const toValue = afterValue[key];
    const fromJson = stableStringify(fromValue);
    const toJson = stableStringify(toValue);
    if (fromJson === toJson) {
      continue;
    }
    if (isPlainObject(fromValue) && isPlainObject(toValue)) {
      const nested = computeDiff(fromValue, toValue);
      if (nested && Object.keys(nested).length > 0) {
        diff[key] = nested;
      }
    } else {
      diff[key] = { from: fromValue ?? null, to: toValue ?? null };
    }
  }
  return Object.keys(diff).length > 0 ? diff : undefined;
}

@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditContext: AuditContextStore,
  ) {}

  async logEvent(event: AuditEvent) {
    const context = this.auditContext.get();
    const enrichedMetadata: Record<string, unknown> = {
      ...(context?.metadata ?? {}),
      ...(event.metadata ?? {}),
    };
    const businessId = event.businessId ?? context?.businessId ?? '';
    const timestamp = event.timestamp ?? new Date().toISOString();
    const requestId =
      event.requestId ??
      context?.requestId ??
      (enrichedMetadata.requestId as string | undefined);
    const sessionId =
      event.sessionId ??
      context?.sessionId ??
      (enrichedMetadata.sessionId as string | undefined);
    const correlationId =
      event.correlationId ??
      context?.correlationId ??
      (enrichedMetadata.correlationId as string | undefined);
    const resolvedUserId =
      event.userId === 'system' && context?.userId
        ? context.userId
        : (event.userId ?? context?.userId ?? null);
    const roleId = event.roleId ?? context?.roleId ?? null;
    const branchId = event.branchId ?? context?.branchId ?? null;
    const deviceId = event.deviceId ?? context?.deviceId ?? null;
    const hasResourceName =
      typeof enrichedMetadata.resourceName === 'string' ||
      typeof enrichedMetadata.name === 'string' ||
      typeof enrichedMetadata.title === 'string';
    if (!hasResourceName && event.resourceType && event.resourceId) {
      const resourceName = await resolveResourceName(this.prisma, {
        businessId,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
      });
      if (resourceName) {
        enrichedMetadata.resourceName = resourceName;
      }
    }
    const isHighRisk = HIGH_RISK_ACTIONS.has(event.action);
    {
      const [branch, role, user, device] = await Promise.all([
        branchId && businessId
          ? this.prisma.branch.findFirst({
              where: { id: branchId, businessId },
              select: { name: true },
            })
          : Promise.resolve(null),
        roleId && businessId
          ? this.prisma.role.findFirst({
              where: { id: roleId, businessId },
              select: { name: true },
            })
          : Promise.resolve(null),
        resolvedUserId
          ? this.prisma.user.findFirst({
              where: { id: resolvedUserId },
              select: { name: true, email: true },
            })
          : Promise.resolve(null),
        deviceId && businessId
          ? this.prisma.offlineDevice.findFirst({
              where: { id: deviceId, businessId },
              select: { deviceName: true },
            })
          : Promise.resolve(null),
      ]);
      if (branch?.name && typeof enrichedMetadata.branchName !== 'string') {
        enrichedMetadata.branchName = branch.name;
      }
      if (role?.name && typeof enrichedMetadata.roleName !== 'string') {
        enrichedMetadata.roleName = role.name;
      }
      if (
        (user?.name || user?.email) &&
        typeof enrichedMetadata.userName !== 'string'
      ) {
        enrichedMetadata.userName = user?.name || user?.email || resolvedUserId;
      }
      if (
        device?.deviceName &&
        typeof enrichedMetadata.deviceName !== 'string'
      ) {
        enrichedMetadata.deviceName = device.deviceName;
      }
    }
    let before = event.before ?? null;
    let after = event.after ?? null;
    if (!before && event.resourceType && event.resourceId) {
      const previous = await this.prisma.auditLog.findFirst({
        where: {
          businessId,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
        },
        orderBy: { createdAt: 'desc' },
        select: { after: true, before: true },
      });
      const previousAfter = previous?.after as Record<string, unknown> | null;
      const previousBefore = previous?.before as Record<string, unknown> | null;
      before = previousAfter ?? previousBefore ?? null;
    }
    if (
      !after &&
      event.resourceType &&
      event.resourceId &&
      !SNAPSHOT_EXCLUDED_ACTIONS.has(event.action) &&
      !event.action.startsWith(REPORT_ACTION_PREFIX) &&
      !event.action.startsWith(EXPORT_ACTION_PREFIX)
    ) {
      const snapshot = await fetchSnapshot(this.prisma, {
        businessId,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
      });
      if (snapshot) {
        after = snapshot as Record<string, unknown>;
      }
    }
    const metadata = Object.keys(enrichedMetadata).length
      ? enrichedMetadata
      : undefined;
    const derivedReason =
      event.reason ??
      (typeof metadata?.reason === 'string' ? metadata.reason : undefined);
    const reasonMissing = isHighRisk && !derivedReason;
    const reason = reasonMissing ? 'UNSPECIFIED' : (derivedReason ?? null);
    const diff =
      event.diff ?? (before || after ? computeDiff(before, after) : undefined);
    const previousLog = await this.prisma.auditLog.findFirst({
      where: { businessId: event.businessId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { hash: true },
    });
    const previousHash = previousLog?.hash ?? null;
    const payload = {
      businessId,
      userId: resolvedUserId,
      roleId,
      branchId,
      requestId: requestId ?? null,
      sessionId: sessionId ?? null,
      correlationId: correlationId ?? null,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId ?? null,
      outcome: event.outcome,
      reason,
      metadata,
      before,
      after,
      diff: diff ?? null,
      deviceId,
      offlineAt: event.offlineAt ?? null,
      createdAt: timestamp,
      previousHash,
    };
    const hash = createHash('sha256')
      .update(stableStringify(payload))
      .digest('hex');
    const created = await this.prisma.auditLog.create({
      data: {
        businessId,
        userId: resolvedUserId,
        roleId,
        branchId,
        requestId: requestId ?? null,
        sessionId: sessionId ?? null,
        correlationId: correlationId ?? null,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId ?? null,
        outcome: event.outcome,
        reason,
        metadata: metadata
          ? ({
              ...metadata,
              ...(reasonMissing ? { reasonMissing: true } : {}),
            } as Prisma.InputJsonValue)
          : undefined,
        before: before ? (before as Prisma.InputJsonValue) : undefined,
        after: after ? (after as Prisma.InputJsonValue) : undefined,
        diff: diff ? (diff as Prisma.InputJsonValue) : undefined,
        deviceId,
        offlineAt: event.offlineAt ? new Date(event.offlineAt) : null,
        createdAt: new Date(timestamp),
        previousHash,
        hash,
      },
    });
    await this.prisma.business
      .update({
        where: { id: businessId },
        data: { lastActivityAt: new Date(timestamp) },
      })
      .catch(() => null);
    if (isHighRisk) {
      await this.prisma.notification.create({
        data: {
          businessId,
          permission: 'audit.read',
          title: 'High-risk action logged',
          message: `${event.action} recorded (${event.outcome}).`,
          priority: 'SECURITY',
          metadata: {
            auditLogId: created.id,
            action: event.action,
            outcome: event.outcome,
            reason,
          } as Prisma.InputJsonValue,
        },
      });
    }
    return created;
  }
}
