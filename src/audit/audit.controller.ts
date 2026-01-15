import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { buildPaginatedResponse, parsePagination } from '../common/pagination';
import type { Response } from 'express';
import PDFDocument from 'pdfkit';
import { resolveResourceNames } from '../common/resource-labels';

const TRACE_KEYS = new Set([
  'requestId',
  'sessionId',
  'correlationId',
  'previousHash',
  'hash',
]);

const KEY_TYPE_MAP: Record<string, string> = {
  userId: 'User',
  roleId: 'Role',
  branchId: 'Branch',
  deviceId: 'OfflineDevice',
  variantId: 'Variant',
  productId: 'Product',
  categoryId: 'Category',
  customerId: 'Customer',
  supplierId: 'Supplier',
  permissionId: 'Permission',
  purchaseId: 'Purchase',
  purchaseOrderId: 'PurchaseOrder',
  purchasePaymentId: 'PurchasePayment',
  saleId: 'Sale',
  saleRefundId: 'SaleRefund',
  saleSettlementId: 'SaleSettlement',
  expenseId: 'Expense',
  approvalId: 'Approval',
  approvalPolicyId: 'ApprovalPolicy',
  movementId: 'StockMovement',
  stockMovementId: 'StockMovement',
  stockSnapshotId: 'StockSnapshot',
  reorderPointId: 'ReorderPoint',
  batchId: 'Batch',
  barcodeId: 'Barcode',
  attachmentId: 'Attachment',
  notificationId: 'Notification',
  unitId: 'Unit',
  priceListId: 'PriceList',
  priceListItemId: 'PriceListItem',
  shiftId: 'Shift',
  subscriptionId: 'Subscription',
  subscriptionRequestId: 'SubscriptionRequest',
  supportAccessRequestId: 'SupportAccessRequest',
  transferId: 'Transfer',
  supplierReturnId: 'SupplierReturn',
  receivingLineId: 'ReceivingLine',
  refreshTokenId: 'RefreshToken',
  invitationId: 'Invitation',
  exportJobId: 'ExportJob',
  offlineActionId: 'OfflineAction',
  offlineDeviceId: 'OfflineDevice',
  businessId: 'Business',
  businessSettingsId: 'BusinessSettings',
  receiptId: 'Receipt',
};

const toKey = (type: string, id: string) => `${type}:${id}`;

const isDiffEntry = (input: unknown) =>
  typeof input === 'object' &&
  input !== null &&
  !Array.isArray(input) &&
  ('from' in (input as Record<string, unknown>) ||
    'to' in (input as Record<string, unknown>));

const collectIdRefs = (
  value: unknown,
  refs: Array<{ resourceType: string; resourceId: string }>,
  key?: string,
  contextType?: string,
) => {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectIdRefs(entry, refs, key, contextType));
    return;
  }
  if (typeof value !== 'object') {
    return;
  }
  const objectValue = value as Record<string, unknown>;
  const nextContextType =
    typeof objectValue.resourceType === 'string'
      ? objectValue.resourceType
      : contextType;
  if (
    typeof objectValue.resourceType === 'string' &&
    typeof objectValue.resourceId === 'string'
  ) {
    refs.push({
      resourceType: objectValue.resourceType,
      resourceId: objectValue.resourceId,
    });
  }
  if (
    typeof objectValue.targetType === 'string' &&
    typeof objectValue.targetId === 'string'
  ) {
    refs.push({
      resourceType: objectValue.targetType,
      resourceId: objectValue.targetId,
    });
  }
  Object.entries(objectValue).forEach(([entryKey, entryValue]) => {
    if (TRACE_KEYS.has(entryKey)) {
      return;
    }
    const mappedType = KEY_TYPE_MAP[entryKey];
    if (mappedType) {
      if (isDiffEntry(entryValue)) {
        const diffEntry = entryValue as Record<string, unknown>;
        if (typeof diffEntry.from === 'string') {
          refs.push({ resourceType: mappedType, resourceId: diffEntry.from });
        }
        if (typeof diffEntry.to === 'string') {
          refs.push({ resourceType: mappedType, resourceId: diffEntry.to });
        }
        return;
      }
      if (typeof entryValue === 'string') {
        refs.push({ resourceType: mappedType, resourceId: entryValue });
      } else if (Array.isArray(entryValue)) {
        entryValue.forEach((id) => {
          if (typeof id === 'string') {
            refs.push({ resourceType: mappedType, resourceId: id });
          }
        });
      }
    } else if (
      entryKey === 'id' &&
      nextContextType &&
      isDiffEntry(entryValue)
    ) {
      const diffEntry = entryValue as Record<string, unknown>;
      if (typeof diffEntry.from === 'string') {
        refs.push({
          resourceType: nextContextType,
          resourceId: diffEntry.from,
        });
      }
      if (typeof diffEntry.to === 'string') {
        refs.push({
          resourceType: nextContextType,
          resourceId: diffEntry.to,
        });
      }
      return;
    } else if (entryKey.endsWith('Ids') && Array.isArray(entryValue)) {
      const singular = `${entryKey.slice(0, -1)}`;
      const listType = KEY_TYPE_MAP[singular];
      if (listType) {
        entryValue.forEach((id) => {
          if (typeof id === 'string') {
            refs.push({ resourceType: listType, resourceId: id });
          }
        });
      }
    }
    collectIdRefs(entryValue, refs, entryKey, nextContextType);
  });
};

const resolveObject = (
  value: unknown,
  labels: Map<string, string>,
  context: { resourceType?: string | null },
  key?: string,
) => {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveObject(entry, labels, context, key));
  }
  if (typeof value !== 'object') {
    return value;
  }
  const objectValue = value as Record<string, unknown>;
  const localResourceType =
    typeof objectValue.resourceType === 'string'
      ? objectValue.resourceType
      : (context.resourceType ?? undefined);
  const targetType =
    typeof objectValue.targetType === 'string' ? objectValue.targetType : null;
  const resolved: Record<string, unknown> = {};
  const resolveIdValue = (type: string, input: unknown) => {
    if (typeof input === 'string') {
      return labels.get(toKey(type, input)) ?? input;
    }
    if (Array.isArray(input)) {
      return input.map((item) =>
        typeof item === 'string'
          ? (labels.get(toKey(type, item)) ?? item)
          : item,
      );
    }
    return input;
  };
  const isDiffEntry = (input: unknown) =>
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    ('from' in (input as Record<string, unknown>) ||
      'to' in (input as Record<string, unknown>));
  Object.entries(objectValue).forEach(([entryKey, entryValue]) => {
    if (TRACE_KEYS.has(entryKey)) {
      resolved[entryKey] = entryValue;
      return;
    }
    if (
      entryKey === 'id' &&
      localResourceType &&
      typeof entryValue === 'string' &&
      (key === 'before' || key === 'after')
    ) {
      resolved[entryKey] = resolveIdValue(localResourceType, entryValue);
      return;
    }
    if (
      entryKey === 'resourceId' &&
      localResourceType &&
      typeof entryValue === 'string'
    ) {
      resolved[entryKey] =
        labels.get(toKey(localResourceType, entryValue)) ?? entryValue;
      return;
    }
    if (
      entryKey === 'targetId' &&
      targetType &&
      typeof entryValue === 'string'
    ) {
      resolved[entryKey] =
        labels.get(toKey(targetType, entryValue)) ?? entryValue;
      return;
    }
    const mappedType = KEY_TYPE_MAP[entryKey];
    if (mappedType && isDiffEntry(entryValue)) {
      const diffEntry = entryValue as Record<string, unknown>;
      resolved[entryKey] = {
        ...diffEntry,
        from: resolveIdValue(mappedType, diffEntry.from),
        to: resolveIdValue(mappedType, diffEntry.to),
      };
      return;
    }
    if (entryKey === 'id' && localResourceType && isDiffEntry(entryValue)) {
      const diffEntry = entryValue as Record<string, unknown>;
      resolved[entryKey] = {
        ...diffEntry,
        from: resolveIdValue(localResourceType, diffEntry.from),
        to: resolveIdValue(localResourceType, diffEntry.to),
      };
      return;
    }
    if (mappedType && typeof entryValue === 'string') {
      resolved[entryKey] =
        labels.get(toKey(mappedType, entryValue)) ?? entryValue;
      return;
    }
    if (mappedType && Array.isArray(entryValue)) {
      resolved[entryKey] = entryValue.map((id) =>
        typeof id === 'string' ? (labels.get(toKey(mappedType, id)) ?? id) : id,
      );
      return;
    }
    if (entryKey.endsWith('Ids') && Array.isArray(entryValue)) {
      const singular = `${entryKey.slice(0, -1)}`;
      const listType = KEY_TYPE_MAP[singular];
      if (listType) {
        resolved[entryKey] = entryValue.map((id) =>
          typeof id === 'string' ? (labels.get(toKey(listType, id)) ?? id) : id,
        );
        return;
      }
    }
    resolved[entryKey] = resolveObject(
      entryValue,
      labels,
      { resourceType: localResourceType },
      entryKey,
    );
  });
  return resolved;
};

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  private buildWhere(
    businessId: string,
    branchScope: string[],
    query: {
      branchId?: string;
      roleId?: string;
      userId?: string;
      action?: string;
      resourceType?: string;
      resourceId?: string;
      outcome?: string;
      offline?: string;
      correlationId?: string;
      requestId?: string;
      sessionId?: string;
      deviceId?: string;
      from?: string;
      to?: string;
      approvalStatus?: string;
      showGuardChecks?: string;
      showDashboardReports?: string;
      showAuthRefresh?: string;
    },
  ) {
    const scopedBranchFilter =
      branchScope.length > 0 ? { branchId: { in: branchScope } } : {};
    const offlineFilter =
      query.offline === 'true' || query.offline === '1'
        ? { metadata: { path: ['offline'], equals: true } }
        : query.offline === 'false' || query.offline === '0'
          ? { metadata: { path: ['offline'], equals: false } }
          : {};
    const approvalFilter =
      query.approvalStatus === 'REQUESTED'
        ? { action: { in: ['APPROVAL_REQUEST', 'APPROVAL_SELF_APPROVE'] } }
        : query.approvalStatus === 'APPROVED'
          ? { action: { in: ['APPROVAL_APPROVE', 'APPROVAL_SELF_APPROVE'] } }
          : query.approvalStatus === 'REJECTED'
            ? { action: 'APPROVAL_REJECT' }
            : {};
    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;
    const timeFilter =
      from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {};

    const guardActions = ['PERMISSION_CHECK', 'SUBSCRIPTION_CHECK'];
    const authActions = ['AUTH_REFRESH', 'AUTH_REFRESH_REUSE'];
    const showGuardChecks =
      query.showGuardChecks === 'true' || query.showGuardChecks === '1';
    const showAuthRefresh =
      query.showAuthRefresh === 'true' || query.showAuthRefresh === '1';
    const excludedActions: string[] = [];
    if (!showGuardChecks && !query.action) {
      excludedActions.push(...guardActions);
    }
    if (!showAuthRefresh && !query.action) {
      excludedActions.push(...authActions);
    }
    const actionFilter =
      excludedActions.length > 0 ? { action: { notIn: excludedActions } } : {};
    const showDashboardReports =
      query.showDashboardReports === 'true' ||
      query.showDashboardReports === '1';
    const dashboardFilter = showDashboardReports
      ? {}
      : {
          OR: [
            { metadata: { equals: Prisma.DbNull } },
            { metadata: { equals: Prisma.JsonNull } },
            { metadata: { path: ['auditOrigin'], equals: Prisma.AnyNull } },
            { metadata: { path: ['auditOrigin'], not: 'dashboard' } },
          ],
        };

    return {
      businessId,
      ...(query.branchId ? { branchId: query.branchId } : scopedBranchFilter),
      ...(query.roleId ? { roleId: query.roleId } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.resourceType ? { resourceType: query.resourceType } : {}),
      ...(query.resourceId ? { resourceId: query.resourceId } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
      ...(query.correlationId ? { correlationId: query.correlationId } : {}),
      ...(query.requestId ? { requestId: query.requestId } : {}),
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      ...(query.deviceId ? { deviceId: query.deviceId } : {}),
      ...offlineFilter,
      ...approvalFilter,
      ...timeFilter,
      ...actionFilter,
      ...dashboardFilter,
    };
  }

  private buildNarrative(log: {
    action: string;
    resourceType: string;
    resourceId?: string | null;
    outcome: string;
    reason?: string | null;
    metadata?: Record<string, unknown> | null;
  }) {
    const action = log.action.replaceAll('_', ' ').toLowerCase();
    const resourceLabel =
      typeof log.metadata?.resourceName === 'string'
        ? log.metadata.resourceName
        : typeof log.metadata?.name === 'string'
          ? log.metadata.name
          : typeof log.metadata?.title === 'string'
            ? log.metadata.title
            : log.resourceId;
    const resource = resourceLabel
      ? `${log.resourceType} ${resourceLabel}`
      : log.resourceType;
    const reason = log.reason ? ` Reason: ${log.reason}.` : '';
    const outcome = log.outcome === 'SUCCESS' ? 'completed' : 'failed';
    const impact =
      typeof log.metadata?.impact === 'string'
        ? ` Impact: ${log.metadata.impact}.`
        : '';
    return `${action} on ${resource} ${outcome}.${reason}${impact}`.trim();
  }

  @Get()
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @Permissions(PermissionsList.AUDIT_READ)
  list(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      branchId?: string;
      roleId?: string;
      userId?: string;
      action?: string;
      resourceType?: string;
      resourceId?: string;
      outcome?: string;
      offline?: string;
      from?: string;
      to?: string;
      approvalStatus?: string;
      correlationId?: string;
      requestId?: string;
      sessionId?: string;
      deviceId?: string;
      includeTotal?: string;
      showGuardChecks?: string;
      showDashboardReports?: string;
      showAuthRefresh?: string;
    },
  ) {
    const pagination = parsePagination(query, 50, 200);
    const branchScope: string[] = req.user?.branchScope || [];
    if (
      query.branchId &&
      branchScope.length > 0 &&
      !branchScope.includes(query.branchId)
    ) {
      return buildPaginatedResponse([], pagination.take, 0);
    }
    const where = {
      ...this.buildWhere(req.user?.businessId || '', branchScope, query),
    };
    const includeTotal =
      query.includeTotal === 'true' || query.includeTotal === '1';
    return Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...pagination,
      }),
      includeTotal
        ? this.prisma.auditLog.count({ where })
        : Promise.resolve(null),
    ]).then(async ([items, total]) => {
      const refs: Array<{ resourceType: string; resourceId: string }> = [];
      const needsLabel = items.filter((item) => {
        const metadata = item.metadata as Record<string, unknown> | null;
        const hasName =
          typeof metadata?.resourceName === 'string' ||
          typeof metadata?.name === 'string' ||
          typeof metadata?.title === 'string';
        return !hasName && item.resourceType && item.resourceId;
      });
      items.forEach((item) => {
        if (item.resourceType && item.resourceId) {
          refs.push({
            resourceType: item.resourceType,
            resourceId: item.resourceId,
          });
        }
        collectIdRefs(item.metadata, refs);
        collectIdRefs(item.before, refs);
        collectIdRefs(item.after, refs);
        collectIdRefs(item.diff, refs);
        if (item.userId) {
          refs.push({ resourceType: 'User', resourceId: item.userId });
        }
        if (item.roleId) {
          refs.push({ resourceType: 'Role', resourceId: item.roleId });
        }
        if (item.branchId) {
          refs.push({ resourceType: 'Branch', resourceId: item.branchId });
        }
        if (item.deviceId) {
          refs.push({
            resourceType: 'OfflineDevice',
            resourceId: item.deviceId,
          });
        }
      });
      const labels =
        refs.length > 0 && req.user?.businessId
          ? await resolveResourceNames(this.prisma, req.user.businessId, refs)
          : new Map<string, string>();
      const deviceIds = Array.from(
        new Set(
          items
            .map((item) => item.deviceId)
            .filter((id): id is string => Boolean(id)),
        ),
      );
      const deviceLookup =
        deviceIds.length > 0 && req.user?.businessId
          ? await this.prisma.offlineDevice.findMany({
              where: { businessId: req.user.businessId, id: { in: deviceIds } },
              select: { id: true, deviceName: true },
            })
          : [];
      const deviceMap = new Map(
        deviceLookup.map((device) => [device.id, device.deviceName]),
      );
      const enrichedItems = items.map((item) => {
        const metadata = item.metadata as Record<string, unknown> | null;
        const hasName =
          typeof metadata?.resourceName === 'string' ||
          typeof metadata?.name === 'string' ||
          typeof metadata?.title === 'string';
        const deviceName = item.deviceId
          ? (deviceMap.get(item.deviceId) ?? null)
          : null;
        const label =
          item.resourceType && item.resourceId
            ? labels.get(`${item.resourceType}:${item.resourceId}`)
            : null;
        const resolved = resolveObject(item, labels, {
          resourceType: item.resourceType,
        });
        return {
          ...item,
          metadata: {
            ...(metadata ?? {}),
            ...(label ? { resourceName: label } : {}),
            ...(deviceName ? { deviceName } : {}),
          },
          resolved,
        };
      });
      return buildPaginatedResponse(
        enrichedItems,
        pagination.take,
        typeof total === 'number' ? total : undefined,
      );
    });
  }

  @Get('export')
  @Permissions(PermissionsList.AUDIT_READ)
  async export(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Query()
    query: {
      branchId?: string;
      roleId?: string;
      userId?: string;
      action?: string;
      resourceType?: string;
      resourceId?: string;
      outcome?: string;
      offline?: string;
      correlationId?: string;
      requestId?: string;
      sessionId?: string;
      deviceId?: string;
      from?: string;
      to?: string;
      approvalStatus?: string;
      format?: string;
      showGuardChecks?: string;
      showDashboardReports?: string;
      showAuthRefresh?: string;
    },
    @Res() res: Response,
  ) {
    const branchScope: string[] = req.user?.branchScope || [];
    const where = this.buildWhere(
      req.user?.businessId || '',
      branchScope,
      query,
    );
    const logs = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 2000,
    });

    const format = (query.format ?? 'csv').toLowerCase();
    if (format === 'pdf') {
      const doc = new PDFDocument({ margin: 36 });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="audit-logs.pdf"',
      );
      doc.pipe(res);
      doc.fontSize(16).text('Audit Logs Export', { underline: true });
      doc.moveDown();
      logs.forEach((log) => {
        doc
          .fontSize(10)
          .text(
            `${new Date(log.createdAt).toLocaleString()} • ${log.action} • ${log.outcome}`,
          )
          .text(this.buildNarrative(log as any))
          .moveDown(0.5);
      });
      doc.end();
      return;
    }

    const header = [
      'createdAt',
      'action',
      'resourceType',
      'resourceId',
      'outcome',
      'reason',
      'userId',
      'roleId',
      'branchId',
      'requestId',
      'sessionId',
      'correlationId',
      'deviceId',
      'offline',
      'narrative',
      'diff',
      'metadata',
    ];
    const lines = logs.map((log) => {
      const offline = log.metadata?.['offline'] ?? '';
      const narrative = this.buildNarrative(log as any);
      return [
        log.createdAt.toISOString(),
        log.action,
        log.resourceType,
        log.resourceId ?? '',
        log.outcome,
        log.reason ?? '',
        log.userId ?? '',
        log.roleId ?? '',
        log.branchId ?? '',
        log.requestId ?? '',
        log.sessionId ?? '',
        log.correlationId ?? '',
        log.deviceId ?? '',
        String(offline),
        narrative,
        log.diff ? JSON.stringify(log.diff) : '',
        log.metadata ? JSON.stringify(log.metadata) : '',
      ]
        .map((value) => `"${String(value).replaceAll('"', '""')}"`)
        .join(',');
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="audit-logs.csv"',
    );
    res.send([header.join(','), ...lines].join('\n'));
  }

  @Get(':id')
  @Permissions(PermissionsList.AUDIT_READ)
  getById(
    @Req() req: { user?: { businessId: string } },
    @Param('id') id: string,
  ) {
    return this.prisma.auditLog.findFirst({
      where: { id, businessId: req.user?.businessId || '' },
    });
  }
}
