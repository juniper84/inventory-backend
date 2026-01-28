import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExportJobStatus, ExportJobType, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { toCsv } from '../common/csv';
import { StorageService } from '../storage/storage.service';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';
import { createZip } from './zip';

@Injectable()
export class ExportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly storageService: StorageService,
    private readonly configService: ConfigService,
  ) {}

  private serializeValue(value: unknown) {
    if (value === null || value === undefined) {
      return '';
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value === 'object') {
      if (
        typeof (value as { toString?: () => string }).toString === 'function'
      ) {
        const printed = (value as { toString?: () => string }).toString?.();
        if (printed && printed !== '[object Object]') {
          return printed;
        }
      }
      return JSON.stringify(value);
    }
    return String(value);
  }

  private buildCsvFile(
    filename: string,
    records: Array<Record<string, unknown>>,
  ) {
    if (!records.length) {
      return { filename, csv: '' };
    }
    const headers = Array.from(
      new Set(records.flatMap((record) => Object.keys(record))),
    ).sort();
    const rows = records.map((record) => {
      const normalized: Record<string, string> = {};
      headers.forEach((header) => {
        normalized[header] = this.serializeValue(record[header]);
      });
      return normalized;
    });
    return { filename, csv: toCsv(headers, rows) };
  }

  private async exportOnExitBundle(businessId: string) {
    const [
      business,
      settings,
      branches,
      subscription,
      subscriptionHistory,
      exportJobs,
      users,
      memberships,
      roles,
      permissions,
      rolePermissions,
      userRoles,
      categories,
      products,
      variants,
      barcodes,
      units,
      productImages,
      branchVariantAvailability,
      stockMovements,
      stockSnapshots,
      batches,
      sales,
      saleLines,
      salePayments,
      saleRefunds,
      saleRefundLines,
      saleSettlements,
      receipts,
      purchases,
      purchaseLines,
      purchaseOrders,
      purchaseOrderLines,
      receivingLines,
      purchasePayments,
      suppliers,
      supplierReturns,
      supplierReturnLines,
      customers,
      priceLists,
      priceListItems,
      shifts,
      approvals,
      approvalPolicies,
      notifications,
      offlineDevices,
      offlineActions,
      attachments,
      auditLogs,
    ] = await this.prisma.$transaction([
      this.prisma.business.findMany({ where: { id: businessId } }),
      this.prisma.businessSettings.findMany({ where: { businessId } }),
      this.prisma.branch.findMany({ where: { businessId } }),
      this.prisma.subscription.findMany({ where: { businessId } }),
      this.prisma.subscriptionHistory.findMany({ where: { businessId } }),
      this.prisma.exportJob.findMany({ where: { businessId } }),
      this.prisma.user.findMany({
        where: { memberships: { some: { businessId } } },
      }),
      this.prisma.businessUser.findMany({ where: { businessId } }),
      this.prisma.role.findMany({ where: { businessId } }),
      this.prisma.permission.findMany({}),
      this.prisma.rolePermission.findMany({
        where: { role: { businessId } },
      }),
      this.prisma.userRole.findMany({
        where: { role: { businessId } },
      }),
      this.prisma.category.findMany({ where: { businessId } }),
      this.prisma.product.findMany({ where: { businessId } }),
      this.prisma.variant.findMany({ where: { businessId } }),
      this.prisma.barcode.findMany({ where: { businessId } }),
      this.prisma.unit.findMany({
        where: { OR: [{ businessId }, { businessId: null }] },
      }),
      this.prisma.productImage.findMany({ where: { businessId } }),
      this.prisma.branchVariantAvailability.findMany({ where: { businessId } }),
      this.prisma.stockMovement.findMany({ where: { businessId } }),
      this.prisma.stockSnapshot.findMany({ where: { businessId } }),
      this.prisma.batch.findMany({ where: { businessId } }),
      this.prisma.sale.findMany({ where: { businessId } }),
      this.prisma.saleLine.findMany({ where: { sale: { businessId } } }),
      this.prisma.salePayment.findMany({ where: { sale: { businessId } } }),
      this.prisma.saleRefund.findMany({ where: { businessId } }),
      this.prisma.saleRefundLine.findMany({
        where: { refund: { businessId } },
      }),
      this.prisma.saleSettlement.findMany({ where: { businessId } }),
      this.prisma.receipt.findMany({ where: { sale: { businessId } } }),
      this.prisma.purchase.findMany({ where: { businessId } }),
      this.prisma.purchaseLine.findMany({
        where: { purchase: { businessId } },
      }),
      this.prisma.purchaseOrder.findMany({ where: { businessId } }),
      this.prisma.purchaseOrderLine.findMany({
        where: { purchaseOrder: { businessId } },
      }),
      this.prisma.receivingLine.findMany({
        where: {
          OR: [{ purchase: { businessId } }, { purchaseOrder: { businessId } }],
        },
      }),
      this.prisma.purchasePayment.findMany({ where: { businessId } }),
      this.prisma.supplier.findMany({ where: { businessId } }),
      this.prisma.supplierReturn.findMany({ where: { businessId } }),
      this.prisma.supplierReturnLine.findMany({
        where: { supplierReturn: { businessId } },
      }),
      this.prisma.customer.findMany({ where: { businessId } }),
      this.prisma.priceList.findMany({ where: { businessId } }),
      this.prisma.priceListItem.findMany({
        where: { priceList: { businessId } },
      }),
      this.prisma.shift.findMany({ where: { businessId } }),
      this.prisma.approval.findMany({ where: { businessId } }),
      this.prisma.approvalPolicy.findMany({ where: { businessId } }),
      this.prisma.notification.findMany({ where: { businessId } }),
      this.prisma.offlineDevice.findMany({ where: { businessId } }),
      this.prisma.offlineAction.findMany({ where: { businessId } }),
      this.prisma.attachment.findMany({ where: { businessId } }),
      this.prisma.auditLog.findMany({ where: { businessId } }),
    ]);

    const unitMap = new Map(units.map((unit) => [unit.id, unit]));
    const variantUnitMap = new Map(
      variants.map((variant) => [variant.id, variant.baseUnitId ?? null]),
    );
    const withUnitLabels = (records: Array<Record<string, unknown>>) =>
      records.map((record) => {
        const unitId = record.unitId as string | null | undefined;
        const unit = unitId ? (unitMap.get(unitId) ?? null) : null;
        return {
          ...record,
          unit_code: unit?.code ?? '',
          unit_label: unit?.label ?? '',
        };
      });
    const snapshotsWithUnits = stockSnapshots.map((snapshot) => {
      const unitId = variantUnitMap.get(snapshot.variantId) ?? null;
      const unit = unitId ? (unitMap.get(unitId) ?? null) : null;
      return {
        ...snapshot,
        unit_id: unitId ?? '',
        unit_code: unit?.code ?? '',
        unit_label: unit?.label ?? '',
      };
    });

    const files = [
      this.buildCsvFile('business.csv', business),
      this.buildCsvFile('business_settings.csv', settings),
      this.buildCsvFile('branches.csv', branches),
      this.buildCsvFile('subscription.csv', subscription),
      this.buildCsvFile('subscription_history.csv', subscriptionHistory),
      this.buildCsvFile('export_jobs.csv', exportJobs),
      this.buildCsvFile('users.csv', users),
      this.buildCsvFile('business_users.csv', memberships),
      this.buildCsvFile('roles.csv', roles),
      this.buildCsvFile('permissions.csv', permissions),
      this.buildCsvFile('role_permissions.csv', rolePermissions),
      this.buildCsvFile('user_roles.csv', userRoles),
      this.buildCsvFile('categories.csv', categories),
      this.buildCsvFile('products.csv', products),
      this.buildCsvFile('variants.csv', variants),
      this.buildCsvFile('barcodes.csv', barcodes),
      this.buildCsvFile('units.csv', units),
      this.buildCsvFile('product_images.csv', productImages),
      this.buildCsvFile(
        'branch_variant_availability.csv',
        branchVariantAvailability,
      ),
      this.buildCsvFile('stock_movements.csv', withUnitLabels(stockMovements)),
      this.buildCsvFile('stock_snapshots.csv', snapshotsWithUnits),
      this.buildCsvFile('batches.csv', batches),
      this.buildCsvFile('sales.csv', sales),
      this.buildCsvFile('sale_lines.csv', withUnitLabels(saleLines)),
      this.buildCsvFile('sale_payments.csv', salePayments),
      this.buildCsvFile('sale_refunds.csv', saleRefunds),
      this.buildCsvFile(
        'sale_refund_lines.csv',
        withUnitLabels(saleRefundLines),
      ),
      this.buildCsvFile('sale_settlements.csv', saleSettlements),
      this.buildCsvFile('receipts.csv', receipts),
      this.buildCsvFile('purchases.csv', purchases),
      this.buildCsvFile('purchase_lines.csv', withUnitLabels(purchaseLines)),
      this.buildCsvFile('purchase_orders.csv', purchaseOrders),
      this.buildCsvFile(
        'purchase_order_lines.csv',
        withUnitLabels(purchaseOrderLines),
      ),
      this.buildCsvFile('receiving_lines.csv', withUnitLabels(receivingLines)),
      this.buildCsvFile('purchase_payments.csv', purchasePayments),
      this.buildCsvFile('suppliers.csv', suppliers),
      this.buildCsvFile('supplier_returns.csv', supplierReturns),
      this.buildCsvFile(
        'supplier_return_lines.csv',
        withUnitLabels(supplierReturnLines),
      ),
      this.buildCsvFile('customers.csv', customers),
      this.buildCsvFile('price_lists.csv', priceLists),
      this.buildCsvFile('price_list_items.csv', priceListItems),
      this.buildCsvFile('shifts.csv', shifts),
      this.buildCsvFile('approvals.csv', approvals),
      this.buildCsvFile('approval_policies.csv', approvalPolicies),
      this.buildCsvFile('notifications.csv', notifications),
      this.buildCsvFile('offline_devices.csv', offlineDevices),
      this.buildCsvFile('offline_actions.csv', offlineActions),
      this.buildCsvFile('attachments.csv', attachments),
      this.buildCsvFile('audit_logs.csv', auditLogs),
    ];

    return { files, attachments };
  }

  async exportStockCsv(businessId: string, branchId?: string) {
    const snapshots = await this.prisma.stockSnapshot.findMany({
      where: { businessId, ...(branchId ? { branchId } : {}) },
      include: { variant: { include: { baseUnit: true } } },
    });
    const headers = [
      'variant_id',
      'branch_id',
      'quantity',
      'unit_id',
      'unit_code',
      'unit_label',
    ];
    const rows = snapshots.map((snapshot) => ({
      variant_id: snapshot.variantId,
      branch_id: snapshot.branchId,
      quantity: snapshot.quantity,
      unit_id: snapshot.variant.baseUnitId ?? '',
      unit_code: snapshot.variant.baseUnit?.code ?? '',
      unit_label: snapshot.variant.baseUnit?.label ?? '',
    }));
    const csv = toCsv(headers, rows);
    return { filename: 'stock.csv', csv };
  }

  async exportProductsCsv(businessId: string) {
    const products = await this.prisma.product.findMany({
      where: { businessId },
      include: {
        category: true,
        variants: {
          include: { barcodes: true, baseUnit: true, sellUnit: true },
        },
      },
    });
    const rows = products.flatMap((product) =>
      product.variants.map((variant) => ({
        name: product.name,
        category: product.category?.name ?? '',
        status: product.status,
        description: product.description ?? '',
        sku: variant.sku ?? '',
        barcode: variant.barcodes[0]?.code ?? '',
        price: variant.defaultPrice ?? '',
        cost: variant.defaultCost ?? '',
        vat_mode: variant.vatMode,
        base_unit_code: variant.baseUnit?.code ?? '',
        base_unit_label: variant.baseUnit?.label ?? '',
        sell_unit_code: variant.sellUnit?.code ?? '',
        sell_unit_label: variant.sellUnit?.label ?? '',
        conversion_factor: variant.conversionFactor ?? '',
      })),
    );
    const headers = [
      'name',
      'category',
      'status',
      'description',
      'sku',
      'barcode',
      'price',
      'cost',
      'vat_mode',
      'base_unit_code',
      'base_unit_label',
      'sell_unit_code',
      'sell_unit_label',
      'conversion_factor',
    ];
    return { filename: 'products.csv', csv: toCsv(headers, rows) };
  }

  async exportOpeningStockCsv(businessId: string, branchId?: string) {
    const snapshots = await this.prisma.stockSnapshot.findMany({
      where: { businessId, ...(branchId ? { branchId } : {}) },
      include: { variant: { include: { baseUnit: true } } },
    });
    const headers = [
      'variant_id',
      'branch_id',
      'quantity',
      'unit_id',
      'unit_code',
      'unit_label',
      'batch_id',
      'expiry_date',
      'unit_cost',
    ];
    const rows = snapshots.map((row) => ({
      variant_id: row.variantId,
      branch_id: row.branchId,
      quantity: row.quantity,
      unit_id: row.variant.baseUnitId ?? '',
      unit_code: row.variant.baseUnit?.code ?? '',
      unit_label: row.variant.baseUnit?.label ?? '',
      batch_id: '',
      expiry_date: '',
      unit_cost: row.variant.defaultCost ?? '',
    }));
    return { filename: 'opening_stock.csv', csv: toCsv(headers, rows) };
  }

  async exportPriceUpdatesCsv(businessId: string) {
    const variants = await this.prisma.variant.findMany({
      where: { businessId },
      select: { id: true, defaultPrice: true, vatMode: true },
    });
    const headers = ['variant_id', 'price', 'vat_mode'];
    const rows = variants.map((row) => ({
      variant_id: row.id,
      price: row.defaultPrice ?? '',
      vat_mode: row.vatMode,
    }));
    return { filename: 'price_updates.csv', csv: toCsv(headers, rows) };
  }

  async exportSuppliersCsv(businessId: string) {
    const suppliers = await this.prisma.supplier.findMany({
      where: { businessId },
    });
    const headers = ['name', 'status', 'phone', 'email', 'address', 'notes'];
    return {
      filename: 'suppliers.csv',
      csv: toCsv(headers, suppliers),
    };
  }

  async exportBranchesCsv(businessId: string) {
    const branches = await this.prisma.branch.findMany({
      where: { businessId },
    });
    const headers = ['name', 'status', 'address', 'phone'];
    return { filename: 'branches.csv', csv: toCsv(headers, branches) };
  }

  async exportUsersCsv(businessId: string) {
    const users = await this.prisma.user.findMany({
      where: { memberships: { some: { businessId } } },
      include: { roles: { include: { role: true } } },
    });
    const headers = ['name', 'email', 'role', 'status', 'branch_ids'];
    const rows = users.flatMap((user) => {
      if (!user.roles.length) {
        return [
          {
            name: user.name,
            email: user.email,
            role: '',
            status: user.status,
            branch_ids: '',
          },
        ];
      }
      return user.roles.map((role) => ({
        name: user.name,
        email: user.email,
        role: role.role.name,
        status: user.status,
        branch_ids: role.branchId ?? '',
      }));
    });
    return { filename: 'users.csv', csv: toCsv(headers, rows) };
  }

  async exportCustomerReportsCsv(businessId: string, branchId?: string) {
    const data = await this.prisma.sale.groupBy({
      by: ['customerId'],
      where: {
        businessId,
        status: 'COMPLETED',
        ...(branchId ? { branchId } : {}),
      },
      _sum: { total: true },
      _count: { id: true },
    });
    const headers = ['customer_id', 'sales_total', 'sale_count'];
    const rows = data.map((row) => ({
      customer_id: row.customerId ?? '',
      sales_total: row._sum.total ?? 0,
      sale_count: row._count.id ?? 0,
    }));
    return { filename: 'customer_reports.csv', csv: toCsv(headers, rows) };
  }

  async exportAuditLogsCsv(
    businessId: string,
    acknowledgement: string | undefined,
    branchId?: string,
  ) {
    if (acknowledgement !== 'YES') {
      throw new BadRequestException('Audit export requires acknowledgement.');
    }
    const logs = await this.prisma.auditLog.findMany({
      where: { businessId, ...(branchId ? { branchId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    const headers = [
      'id',
      'businessId',
      'userId',
      'roleId',
      'branchId',
      'requestId',
      'sessionId',
      'correlationId',
      'action',
      'resourceType',
      'resourceId',
      'outcome',
      'reason',
      'metadata',
      'before',
      'after',
      'diff',
      'deviceId',
      'offlineAt',
      'previousHash',
      'hash',
      'createdAt',
    ];
    return {
      filename: 'audit_logs.csv',
      csv: toCsv(
        headers,
        logs.map((log) => ({
          ...log,
          metadata: this.serializeValue(log.metadata),
          before: this.serializeValue(log.before),
          after: this.serializeValue(log.after),
          diff: this.serializeValue(log.diff),
        })),
      ),
    };
  }

  async createExportJob(
    businessId: string,
    userId: string,
    data: { type: ExportJobType; acknowledgement?: string; branchId?: string },
    branchScope: string[] = [],
  ) {
    const scopedBranch = this.resolveBranchScope(branchScope, data.branchId);
    if (branchScope.length > 0) {
      const allowedTypes = new Set<ExportJobType>([
        ExportJobType.STOCK,
        ExportJobType.OPENING_STOCK,
        ExportJobType.AUDIT_LOGS,
        ExportJobType.CUSTOMER_REPORTS,
      ]);
      if (!allowedTypes.has(data.type)) {
        throw new ForbiddenException('Branch-scoped export type not allowed.');
      }
    }
    const job = await this.prisma.exportJob.create({
      data: {
        businessId,
        branchId: scopedBranch ?? null,
        type: data.type,
        status: ExportJobStatus.PENDING,
        requestedByUserId: userId,
        metadata: data.acknowledgement
          ? ({ acknowledgement: data.acknowledgement } as Prisma.InputJsonValue)
          : {},
      },
    });
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'EXPORT_REQUESTED',
      resourceType: 'ExportJob',
      resourceId: job.id,
      outcome: 'SUCCESS',
      metadata: { type: data.type },
    });
    return job;
  }

  async listJobs(
    businessId: string,
    query: PaginationQuery & {
      search?: string;
      status?: string;
      type?: string;
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
    const searchUpper = search?.toUpperCase();
    const searchType =
      searchUpper &&
      Object.values(ExportJobType).includes(searchUpper as ExportJobType)
        ? (searchUpper as ExportJobType)
        : undefined;
    const searchStatus =
      searchUpper &&
      Object.values(ExportJobStatus).includes(searchUpper as ExportJobStatus)
        ? (searchUpper as ExportJobStatus)
        : undefined;
    const searchFilters = search
      ? ([
          { id: { contains: search, mode: Prisma.QueryMode.insensitive } },
          { lastError: { contains: search, mode: Prisma.QueryMode.insensitive } },
          ...(searchType ? [{ type: searchType }] : []),
          ...(searchStatus ? [{ status: searchStatus }] : []),
        ] as Prisma.ExportJobWhereInput[])
      : [];
    const branchFilter = this.resolveBranchScopeFilter(
      branchScope,
      query.branchId,
    );
    const where = {
      businessId,
      ...(branchFilter ? { branchId: branchFilter } : {}),
      ...(query.status ? { status: query.status as ExportJobStatus } : {}),
      ...(query.type ? { type: query.type as ExportJobType } : {}),
      ...(searchFilters.length ? { OR: searchFilters } : {}),
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
      this.prisma.exportJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...pagination,
      }),
      includeTotal
        ? this.prisma.exportJob.count({ where })
        : Promise.resolve(null),
    ]).then(([items, total]) =>
      buildPaginatedResponse(
        items,
        pagination.take,
        typeof total === 'number' ? total : undefined,
      ),
    );
  }

  async runNextPendingJob() {
    const maxAttempts = Number(
      this.configService.get('exports.workerMaxAttempts') ?? 3,
    );
    const pending = await this.prisma.exportJob.findFirst({
      where: { status: ExportJobStatus.PENDING, attempts: { lt: maxAttempts } },
      orderBy: { createdAt: 'asc' },
    });
    if (!pending) {
      return null;
    }
    return this.runExportJob(pending.id);
  }

  async runExportJob(jobId: string, acknowledgement?: string) {
    const existing = await this.prisma.exportJob.findFirst({
      where: { id: jobId },
    });
    if (!existing) {
      return null;
    }
    if (existing.status === ExportJobStatus.COMPLETED) {
      return existing;
    }
    const maxAttempts = Number(
      this.configService.get('exports.workerMaxAttempts') ?? 3,
    );
    if (existing.attempts >= maxAttempts) {
      return existing;
    }
    const claimed = await this.prisma.exportJob.updateMany({
      where: {
        id: jobId,
        status: { in: [ExportJobStatus.PENDING, ExportJobStatus.FAILED] },
      },
      data: {
        status: ExportJobStatus.RUNNING,
        startedAt: new Date(),
        attempts: { increment: 1 },
        lastError: null,
      },
    });
    if (claimed.count === 0) {
      return existing;
    }

    const job = await this.prisma.exportJob.findFirst({ where: { id: jobId } });
    if (!job) {
      return null;
    }

    try {
      const storedAck =
        job.metadata && typeof job.metadata === 'object'
          ? (job.metadata as { acknowledgement?: string }).acknowledgement
          : undefined;
      const resolvedAck = acknowledgement ?? storedAck;
      let payload: { filename: string; csv: string } | null = null;
      let metadata: Prisma.InputJsonValue = {};

      switch (job.type as string) {
        case 'STOCK':
          payload = await this.exportStockCsv(
            job.businessId,
            job.branchId ?? undefined,
          );
          break;
        case 'PRODUCTS':
          payload = await this.exportProductsCsv(job.businessId);
          break;
        case 'OPENING_STOCK':
          payload = await this.exportOpeningStockCsv(
            job.businessId,
            job.branchId ?? undefined,
          );
          break;
        case 'PRICE_UPDATES':
          payload = await this.exportPriceUpdatesCsv(job.businessId);
          break;
        case 'SUPPLIERS':
          payload = await this.exportSuppliersCsv(job.businessId);
          break;
        case 'BRANCHES':
          payload = await this.exportBranchesCsv(job.businessId);
          break;
        case 'USERS':
          payload = await this.exportUsersCsv(job.businessId);
          break;
        case 'AUDIT_LOGS':
          payload = await this.exportAuditLogsCsv(
            job.businessId,
            resolvedAck,
            job.branchId ?? undefined,
          );
          break;
        case 'CUSTOMER_REPORTS':
          payload = await this.exportCustomerReportsCsv(
            job.businessId,
            job.branchId ?? undefined,
          );
          break;
        case 'EXPORT_ON_EXIT': {
          const bundle = await this.exportOnExitBundle(job.businessId);
          const files = bundle.files.map((file) => ({
            name: file.filename,
            data: Buffer.from(file.csv ?? '', 'utf8'),
          }));
          const attachmentManifest: Array<Record<string, unknown>> = [];
          for (const attachment of bundle.attachments) {
            const entry: Record<string, unknown> = {
              id: attachment.id,
              filename: attachment.filename,
              url: attachment.url,
              storageKey: attachment.storageKey ?? null,
              status: attachment.status,
            };
            try {
              const downloadUrl = attachment.storageKey
                ? (await this.storageService.createPresignedDownload({
                    key: attachment.storageKey,
                  })).url
                : attachment.url;
              const response = await fetch(downloadUrl);
              if (!response.ok) {
                throw new BadGatewayException({
                  message: `HTTP ${response.status}`,
                  errorCode: 'EXPORTS_HTTP_ERROR',
                });
              }
              const buffer = Buffer.from(await response.arrayBuffer());
              files.push({
                name: `attachments/${attachment.id}-${attachment.filename}`,
                data: buffer,
              });
              entry.downloadStatus = 'OK';
              entry.sizeBytes = buffer.length;
            } catch (error) {
              entry.downloadStatus = 'FAILED';
              entry.errorMessage =
                error instanceof Error
                  ? error.message
                  : 'Attachment download failed.';
            }
            attachmentManifest.push(entry);
          }
          const manifest = {
            generatedAt: new Date().toISOString(),
            fileCount: bundle.files.length,
            attachmentCount: bundle.attachments.length,
          };
          files.push({
            name: 'manifest.json',
            data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
          });
          files.push({
            name: 'attachments_manifest.json',
            data: Buffer.from(
              JSON.stringify(attachmentManifest, null, 2),
              'utf8',
            ),
          });
          const zipBuffer = createZip(files);
          const key = `exports/${job.businessId}/${job.id}/export-on-exit.zip`;
          const upload = await this.storageService.uploadObject({
            key,
            body: zipBuffer,
            contentType: 'application/zip',
          });
          metadata = {
            zipUrl: upload.publicUrl,
            files: bundle.files.map((file) => ({
              filename: file.filename,
              rows: file.csv ? file.csv.split('\n').length - 1 : 0,
            })),
            attachments: bundle.attachments.map((attachment) => ({
              id: attachment.id,
              filename: attachment.filename,
              status: attachment.status,
            })),
            attachmentFailures: attachmentManifest.filter(
              (entry) => entry.downloadStatus !== 'OK',
            ).length,
          } as Prisma.InputJsonValue;
          break;
        }
        default:
          throw new BadRequestException('Unsupported export type.');
      }

      if (payload) {
        metadata = {
          filename: payload.filename,
          csv: payload.csv,
        };
      }

      const updated = await this.prisma.exportJob.update({
        where: { id: job.id },
        data: {
          status: ExportJobStatus.COMPLETED,
          completedAt: new Date(),
          metadata,
        },
      });
      await this.auditService.logEvent({
        businessId: job.businessId,
        userId: job.requestedByUserId ?? 'system',
        action: 'EXPORT_COMPLETED',
        resourceType: 'ExportJob',
        resourceId: job.id,
        outcome: 'SUCCESS',
        metadata: { type: job.type },
      });
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Export failed.';
      const updated = await this.prisma.exportJob.update({
        where: { id: job.id },
        data: {
          status: ExportJobStatus.FAILED,
          completedAt: new Date(),
          lastError: message,
        },
      });
      await this.auditService.logEvent({
        businessId: job.businessId,
        userId: job.requestedByUserId ?? 'system',
        action: 'EXPORT_FAILED',
        resourceType: 'ExportJob',
        resourceId: job.id,
        outcome: 'FAILURE',
        reason: message,
        metadata: { type: job.type },
      });
      return updated;
    }
  }

  async downloadJob(jobId: string) {
    const job = await this.prisma.exportJob.findFirst({ where: { id: jobId } });
    if (!job) {
      return null;
    }
    return job.metadata as {
      filename?: string;
      csv?: string;
      files?: { filename: string; csv: string }[];
      attachments?: { filename: string; url: string }[];
      zipUrl?: string;
    } | null;
  }

  async getWorkerStatus(businessId?: string) {
    const enabled = this.configService.get<boolean>('exports.workerEnabled');
    const intervalMs = Number(
      this.configService.get('exports.workerIntervalMs') ?? 15000,
    );
    const maxAttempts = Number(
      this.configService.get('exports.workerMaxAttempts') ?? 3,
    );
    const where = businessId ? { businessId } : undefined;
    const [pending, running, failed, lastJob] = await Promise.all([
      this.prisma.exportJob.count({
        where: { ...where, status: ExportJobStatus.PENDING },
      }),
      this.prisma.exportJob.count({
        where: { ...where, status: ExportJobStatus.RUNNING },
      }),
      this.prisma.exportJob.count({
        where: { ...where, status: ExportJobStatus.FAILED },
      }),
      this.prisma.exportJob.findFirst({
        where,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          type: true,
          status: true,
          createdAt: true,
          completedAt: true,
        },
      }),
    ]);

    return {
      enabled,
      intervalMs,
      maxAttempts,
      queue: {
        pending,
        running,
        failed,
      },
      lastJob,
    };
  }

  private resolveBranchScope(branchScope: string[], branchId?: string) {
    if (!branchScope.length) {
      return branchId ?? null;
    }
    if (branchId) {
      if (!branchScope.includes(branchId)) {
        throw new ForbiddenException('Branch-scoped role restriction.');
      }
      return branchId;
    }
    throw new ForbiddenException('Branch-scoped exports require a branch.');
  }

  private resolveBranchScopeFilter(branchScope: string[], branchId?: string) {
    if (!branchScope.length) {
      return branchId;
    }
    if (branchId) {
      if (!branchScope.includes(branchId)) {
        throw new ForbiddenException('Branch-scoped role restriction.');
      }
      return branchId;
    }
    return { in: branchScope };
  }
}
