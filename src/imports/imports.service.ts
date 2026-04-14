import { BadRequestException, Injectable } from '@nestjs/common';
import {
  Prisma,
  RecordStatus,
  UserStatus,
  VatMode,
  StockMovementType,
  UnitType,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { parseCsv } from '../common/csv';
import { hashPassword } from '../auth/password';

type ImportType =
  | 'categories'
  | 'products'
  | 'opening_stock'
  | 'price_updates'
  | 'status_updates'
  | 'suppliers'
  | 'branches'
  | 'users'
  | 'customers'
  | 'units'
  | 'stock_counts';

type PreviewResult = {
  validRows: number;
  invalidRows: number;
  changedRows?: number;
  unchangedRows?: number;
  errors: { row: number; message: string }[];
  preview: Record<string, unknown>[];
};

@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  private async generateBatchCode(businessId: string, branchId: string): Promise<string> {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    const prefix = `BATCH-${dateStr}`;
    const existing = await this.prisma.batch.findMany({
      where: { businessId, branchId, code: { startsWith: prefix } },
      select: { code: true },
      orderBy: { code: 'desc' },
      take: 1,
    });
    let sequence = 1;
    if (existing.length > 0) {
      const lastSeq = parseInt(existing[0].code.split('-').pop() || '0', 10);
      sequence = lastSeq + 1;
    }
    return `${prefix}-${String(sequence).padStart(3, '0')}`;
  }

  preview(
    businessId: string,
    data: {
      type: ImportType;
      csv: string;
      options?: { createMissingCategories?: boolean };
    },
  ): Promise<PreviewResult> {
    return this.validate(businessId, data, false);
  }

  async apply(
    businessId: string,
    userId: string,
    data: {
      type: ImportType;
      csv: string;
      options?: { createMissingCategories?: boolean };
    },
  ) {
    const validation = await this.validate(businessId, data, true, userId);
    await this.auditService.logEvent({
      businessId,
      userId,
      action: `IMPORT_${data.type.toUpperCase()}`,
      resourceType: 'Import',
      outcome: validation.invalidRows ? 'FAILURE' : 'SUCCESS',
      metadata: {
        resourceName: `Import ${data.type.replaceAll('_', ' ')}`,
        validRows: validation.validRows,
        invalidRows: validation.invalidRows,
        changedRows: validation.changedRows ?? validation.validRows,
        unchangedRows: validation.unchangedRows ?? 0,
        partial: validation.invalidRows > 0,
      },
    });

    await this.prisma.importHistory.create({
      data: {
        businessId,
        userId,
        type: data.type,
        validRows: validation.validRows,
        invalidRows: validation.invalidRows,
        errors: validation.errors.length ? validation.errors : undefined,
      },
    });

    return validation;
  }

  async listHistory(businessId: string) {
    return this.prisma.importHistory.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { user: { select: { id: true, name: true } } },
    });
  }

  async generatePrefilledTemplate(
    businessId: string,
    type: 'opening_stock' | 'price_updates' | 'status_updates' | 'stock_counts',
  ): Promise<{ csv: string }> {
    const variants = await this.prisma.variant.findMany({
      where: { businessId, status: 'ACTIVE' },
      include: { product: { select: { name: true, status: true } } },
      orderBy: [{ product: { name: 'asc' } }, { name: 'asc' }],
    });
    const branches = await this.prisma.branch.findMany({
      where: { businessId },
      orderBy: { name: 'asc' },
    });

    if (type === 'opening_stock') {
      // Pre-fill with all active variants, branch columns for quantities
      const branchNames = branches.map((b) => b.name);
      const headers = ['product_name', 'variant_name', 'sku (optional)', 'variant_id (optional)', 'batch_id (optional)', 'expiry_date (optional)', 'unit_cost (optional)', ...branchNames];
      const rows = variants.map((v) => {
        const row: Record<string, string> = {
          product_name: v.product?.name ?? '',
          variant_name: v.name,
          'sku (optional)': v.sku ?? '',
          'variant_id (optional)': '',
          'batch_id (optional)': '',
          'expiry_date (optional)': '',
          'unit_cost (optional)': v.defaultCost ? String(v.defaultCost) : '',
        };
        for (const bn of branchNames) {
          row[bn] = '';
        }
        return row;
      });
      const lines = [headers.join(',')];
      for (const row of rows) {
        lines.push(headers.map((h) => row[h] ?? '').join(','));
      }
      return { csv: lines.join('\n') };
    }

    if (type === 'price_updates') {
      const headers = ['product_name', 'variant_name', 'price', 'sku (optional)', 'variant_id (optional)', 'vat_mode (optional)', 'min_price (optional)'];
      const rows = variants.map((v) => [
        v.product?.name ?? '',
        v.name,
        v.defaultPrice ? String(v.defaultPrice) : '',
        v.sku ?? '',
        '',
        v.vatMode ?? '',
        v.minPrice ? String(v.minPrice) : '',
      ]);
      const lines = [headers.join(',')];
      for (const row of rows) {
        lines.push(row.join(','));
      }
      return { csv: lines.join('\n') };
    }

    if (type === 'status_updates') {
      // Include all products (not just active) so you can change statuses
      const products = await this.prisma.product.findMany({
        where: { businessId },
        include: { variants: { select: { name: true, status: true } } },
        orderBy: { name: 'asc' },
      });
      const headers = ['product_name', 'status', 'variant_name (optional)'];
      const rows: string[][] = [];
      for (const product of products) {
        if (product.variants.length <= 1) {
          rows.push([product.name, product.status, '']);
        } else {
          for (const variant of product.variants) {
            rows.push([product.name, variant.status, variant.name]);
          }
        }
      }
      const lines = [headers.join(',')];
      for (const row of rows) {
        lines.push(row.join(','));
      }
      return { csv: lines.join('\n') };
    }

    // stock_counts — similar to opening_stock but with branch columns for counted quantities
    const branchNames = branches.map((b) => b.name);
    const headers = ['product_name', 'variant_name', 'sku (optional)', 'variant_id (optional)', 'reason (optional)', ...branchNames];
    const rows = variants.map((v) => {
      const row: Record<string, string> = {
        product_name: v.product?.name ?? '',
        variant_name: v.name,
        'sku (optional)': v.sku ?? '',
        'variant_id (optional)': '',
        'reason (optional)': '',
      };
      for (const bn of branchNames) {
        row[bn] = '';
      }
      return row;
    });
    const lines = [headers.join(',')];
    for (const row of rows) {
      lines.push(headers.map((h) => row[h] ?? '').join(','));
    }
    return { csv: lines.join('\n') };
  }

  private async validate(
    businessId: string,
    data: {
      type: ImportType;
      csv: string;
      options?: { createMissingCategories?: boolean };
    },
    apply: boolean,
    userId?: string,
  ): Promise<PreviewResult> {
    const { headers, rows } = parseCsv(data.csv);
    if (!headers.length) {
      throw new BadRequestException('CSV must include headers.');
    }
    switch (data.type) {
      case 'categories':
        return this.validateCategories(
          businessId,
          headers,
          rows,
          apply,
          userId,
        );
      case 'products':
        return this.validateProducts(
          businessId,
          headers,
          rows,
          data.options,
          apply,
          userId,
        );
      case 'opening_stock':
        return this.validateOpeningStock(
          businessId,
          headers,
          rows,
          apply,
          userId,
        );
      case 'price_updates':
        return this.validatePriceUpdates(
          businessId,
          headers,
          rows,
          apply,
          userId,
        );
      case 'status_updates':
        return this.validateStatusUpdates(
          businessId,
          headers,
          rows,
          apply,
          userId,
        );
      case 'suppliers':
        return this.validateSuppliers(businessId, headers, rows, apply, userId);
      case 'branches':
        return this.validateBranches(businessId, headers, rows, apply, userId);
      case 'users':
        return this.validateUsers(businessId, headers, rows, apply, userId);
      case 'customers':
        return this.validateCustomers(businessId, headers, rows, apply, userId);
      case 'units':
        return this.validateUnits(businessId, headers, rows, apply, userId);
      case 'stock_counts':
        return this.validateStockCounts(businessId, headers, rows, apply, userId);
      default:
        throw new BadRequestException('Unsupported import type.');
    }
  }

  private ensureHeaders(headers: string[], required: string[]) {
    const missing = required.filter((key) => !headers.includes(key));
    if (missing.length) {
      throw new BadRequestException({
        message: `Missing headers: ${missing.join(', ')}`,
        errorCode: 'IMPORT_MISSING_HEADERS',
      });
    }
  }

  private normalizeStatus(value: string, allowed: string[]) {
    const normalized = value.trim().toUpperCase();
    return allowed.includes(normalized) ? normalized : null;
  }

  private normalizeName(value: string) {
    return value.trim().toLowerCase();
  }

  private async logImportEvent(params: {
    businessId: string;
    userId?: string;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    outcome?: 'SUCCESS' | 'FAILURE';
  }) {
    if (!params.userId) {
      return;
    }
    await this.auditService.logEvent({
      businessId: params.businessId,
      userId: params.userId,
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId ?? undefined,
      outcome: params.outcome ?? 'SUCCESS',
      metadata: params.metadata,
      before: params.before ?? undefined,
      after: params.after ?? undefined,
    });
  }

  private async validateCategories(
    businessId: string,
    headers: string[],
    rows: Record<string, string>[],
    apply: boolean,
    userId?: string,
  ): Promise<PreviewResult> {
    this.ensureHeaders(headers, ['name', 'status']);
    const errors: { row: number; message: string }[] = [];
    const preview: Record<string, unknown>[] = [];
    let changedCount = 0;
    let unchangedCount = 0;
    const existing = await this.prisma.category.findMany({
      where: { businessId },
      select: { id: true, name: true, status: true, parentId: true },
    });
    const existingMap = new Map(
      existing.map((category) => [
        this.normalizeName(category.name),
        category.id,
      ]),
    );
    const existingDetailMap = new Map(
      existing.map((category) => [category.id, category]),
    );
    const createdMap = new Map<string, string>();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const name = row.name?.trim();
      const status = this.normalizeStatus(row.status ?? '', [
        'ACTIVE',
        'INACTIVE',
        'ARCHIVED',
      ]);
      if (!name || !status) {
        errors.push({ row: index + 2, message: 'Invalid name or status.' });
        continue;
      }
      const parentName = row.parent?.trim() || null;
      if (
        parentName &&
        this.normalizeName(parentName) === this.normalizeName(name)
      ) {
        errors.push({
          row: index + 2,
          message: 'Category cannot be its own parent.',
        });
        continue;
      }
      preview.push({
        name,
        status,
        parent: parentName,
      });
      if (apply) {
        let parentId: string | null = null;
        if (parentName) {
          parentId =
            createdMap.get(this.normalizeName(parentName)) ??
            existingMap.get(this.normalizeName(parentName)) ??
            null;
          if (!parentId) {
            errors.push({
              row: index + 2,
              message: 'Parent category not found.',
            });
            continue;
          }
        }
        const key = this.normalizeName(name);
        const existingId = existingMap.get(key);
        if (existingId) {
          const detail = existingDetailMap.get(existingId);
          const categoryUnchanged =
            detail != null &&
            detail.status === status &&
            (detail.parentId ?? null) === parentId;
          if (categoryUnchanged) {
            unchangedCount++;
            continue;
          }
          changedCount++;
          await this.prisma.category.updateMany({
            where: { id: existingId, businessId },
            data: { status: status as RecordStatus, parentId },
          });
        } else {
          const created = await this.prisma.category.create({
            data: {
              businessId,
              name,
              status: status as RecordStatus,
              parentId,
            },
          });
          existingMap.set(key, created.id);
          createdMap.set(key, created.id);
        }
      }
    }
    return {
      validRows: preview.length,
      invalidRows: errors.length,
      changedRows: changedCount,
      unchangedRows: unchangedCount,
      errors,
      preview,
    };
  }

  private parseNumber(value: string) {
    const num = Number(value);
    if (Number.isNaN(num)) {
      return null;
    }
    return num;
  }

  /**
   * Resolve a variant by variant_id, sku, or product_name + variant_name.
   * Returns the variant or null. Sets an error message if resolution fails.
   */
  private async resolveVariant(
    businessId: string,
    row: Record<string, string>,
    rowNum: number,
  ): Promise<{ variant: { id: string; name: string } | null; error?: string }> {
    const variantId = row.variant_id?.trim() || null;
    const sku = row.sku?.trim() || null;
    const productName = row.product_name?.trim() || null;
    const variantName = row.variant_name?.trim() || null;

    // 1. By variant_id
    if (variantId) {
      const variant = await this.prisma.variant.findFirst({
        where: { id: variantId, businessId },
        select: { id: true, name: true },
      });
      if (!variant) return { variant: null, error: 'Variant not found.' };
      return { variant };
    }

    // 2. By SKU
    if (sku) {
      const variant = await this.prisma.variant.findFirst({
        where: { businessId, sku },
        select: { id: true, name: true },
      });
      if (!variant) return { variant: null, error: `Variant not found for SKU: ${sku}` };
      return { variant };
    }

    // 3. By product_name + variant_name
    if (productName && variantName) {
      const product = await this.prisma.product.findFirst({
        where: { businessId, name: productName },
        select: { id: true },
      });
      if (!product) return { variant: null, error: `Product not found: ${productName}` };
      const variants = await this.prisma.variant.findMany({
        where: { businessId, productId: product.id, name: variantName },
        select: { id: true, name: true },
      });
      if (variants.length === 0) {
        return { variant: null, error: `Variant "${variantName}" not found under product "${productName}"` };
      }
      if (variants.length > 1) {
        return { variant: null, error: `Multiple variants named "${variantName}" found under "${productName}". Use SKU or variant_id instead.` };
      }
      return { variant: variants[0] };
    }

    return { variant: null, error: 'Provide product_name + variant_name, sku, or variant_id.' };
  }

  private async validateProducts(
    businessId: string,
    headers: string[],
    rows: Record<string, string>[],
    options: { createMissingCategories?: boolean } | undefined,
    apply: boolean,
    userId?: string,
  ): Promise<PreviewResult> {
    this.ensureHeaders(headers, [
      'product_name',
      'category',
      'status',
      'variant_name',
    ]);
    const errors: { row: number; message: string }[] = [];
    const preview: Record<string, unknown>[] = [];
    const allowCreateCategory = options?.createMissingCategories ?? true;
    const existingProducts = await this.prisma.product.findMany({
      where: { businessId },
      select: { name: true },
    });
    const productNames = new Set(
      existingProducts.map((p) => p.name.toLowerCase()),
    );

    // Pre-load units for validation
    const allUnits = await this.prisma.unit.findMany({
      where: { OR: [{ businessId }, { businessId: null }] },
    });
    const unitCodeMap = new Map(
      allUnits.map((u) => [u.code.toLowerCase(), u]),
    );

    // Pre-load branches for validation
    const allBranches = await this.prisma.branch.findMany({
      where: { businessId },
    });
    const branchNameMap = new Map(
      allBranches.map((b) => [b.name.toLowerCase(), b]),
    );

    // First pass: validate all rows and group by product_name
    type ValidatedRow = {
      rowIndex: number;
      productName: string;
      variantName: string;
      categoryName: string;
      description: string | null;
      status: string;
      sku: string | null;
      barcode: string | null;
      price: number | null;
      cost: number | null;
      minPrice: number | null;
      vatMode: string | null;
      baseUnitId: string | null;
      sellUnitId: string | null;
      conversionFactor: number | null;
      trackStock: boolean;
      branchNames: string[];
    };

    const validatedRows: ValidatedRow[] = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const productName = row.product_name?.trim();
      const variantName = row.variant_name?.trim();
      const categoryName = row.category?.trim();
      const status = this.normalizeStatus(row.status ?? '', [
        'ACTIVE',
        'INACTIVE',
        'ARCHIVED',
      ]);
      if (!productName || !variantName || !categoryName || !status) {
        errors.push({
          row: index + 2,
          message:
            'Missing product_name, variant_name, category, or invalid status.',
        });
        continue;
      }
      const vatMode = row.vat_mode
        ? this.normalizeStatus(row.vat_mode, [
            'INCLUSIVE',
            'EXCLUSIVE',
            'EXEMPT',
          ])
        : null;
      if (row.vat_mode && !vatMode) {
        errors.push({ row: index + 2, message: 'Invalid vat_mode.' });
        continue;
      }
      const price = row.price ? this.parseNumber(row.price) : null;
      const cost = row.cost ? this.parseNumber(row.cost) : null;
      if (row.price && (price === null || price < 0)) {
        errors.push({ row: index + 2, message: 'Invalid price.' });
        continue;
      }
      if (row.cost && (cost === null || cost < 0)) {
        errors.push({ row: index + 2, message: 'Invalid cost.' });
        continue;
      }

      // Validate min_price
      const minPrice = row.min_price ? this.parseNumber(row.min_price) : null;
      if (row.min_price && (minPrice === null || minPrice < 0)) {
        errors.push({ row: index + 2, message: 'Invalid min_price.' });
        continue;
      }

      // Validate base_unit
      let baseUnitId: string | null = null;
      if (row.base_unit?.trim()) {
        const unit = unitCodeMap.get(row.base_unit.trim().toLowerCase());
        if (!unit) {
          errors.push({
            row: index + 2,
            message: `Base unit not found: ${row.base_unit.trim()}`,
          });
          continue;
        }
        baseUnitId = unit.id;
      }

      // Validate sell_unit
      let sellUnitId: string | null = null;
      if (row.sell_unit?.trim()) {
        const unit = unitCodeMap.get(row.sell_unit.trim().toLowerCase());
        if (!unit) {
          errors.push({
            row: index + 2,
            message: `Sell unit not found: ${row.sell_unit.trim()}`,
          });
          continue;
        }
        sellUnitId = unit.id;
      }

      // Validate conversion_factor
      const conversionFactor = row.conversion_factor
        ? this.parseNumber(row.conversion_factor)
        : null;
      if (
        row.conversion_factor &&
        (conversionFactor === null || conversionFactor <= 0)
      ) {
        errors.push({
          row: index + 2,
          message: 'Invalid conversion_factor (must be > 0).',
        });
        continue;
      }
      // Require conversion_factor if base_unit and sell_unit differ
      if (baseUnitId && sellUnitId && baseUnitId !== sellUnitId && !conversionFactor) {
        errors.push({
          row: index + 2,
          message:
            'conversion_factor is required when base_unit and sell_unit differ.',
        });
        continue;
      }

      // Validate track_stock
      let trackStock = true;
      if (row.track_stock?.trim()) {
        const ts = row.track_stock.trim().toLowerCase();
        if (ts !== 'true' && ts !== 'false') {
          errors.push({
            row: index + 2,
            message: 'Invalid track_stock (must be true or false).',
          });
          continue;
        }
        trackStock = ts === 'true';
      }

      // Validate branches — support both legacy (semicolon-separated) and dynamic (one column per branch)
      const branchNames: string[] = [];
      if (row.branches?.trim()) {
        // Legacy format: semicolon-separated branch names
        const names = row.branches
          .split(';')
          .map((n) => n.trim())
          .filter((n) => n.length > 0);
        let branchError = false;
        for (const bName of names) {
          const branch = branchNameMap.get(bName.toLowerCase());
          if (!branch) {
            errors.push({
              row: index + 2,
              message: `Branch not found: ${bName}`,
            });
            branchError = true;
            break;
          }
          branchNames.push(bName);
        }
        if (branchError) continue;
      } else {
        // Dynamic format: check for columns matching branch names with yes/true values
        for (const [lowerName, branch] of branchNameMap) {
          // Find the matching header (case-insensitive)
          const matchingHeader = headers.find(
            (h) => h.toLowerCase() === lowerName,
          );
          if (!matchingHeader) continue;
          const cellValue = row[matchingHeader]?.trim().toLowerCase();
          if (cellValue === 'yes' || cellValue === 'true') {
            branchNames.push(branch.name);
          }
        }
      }

      preview.push({
        product_name: productName,
        variant_name: variantName,
        category: categoryName,
        status,
        sku: row.sku?.trim() || null,
        barcode: row.barcode?.trim() || null,
        price,
        cost,
        minPrice,
        vatMode,
        baseUnitId,
        sellUnitId,
        conversionFactor,
        trackStock,
        branches: branchNames.length ? branchNames : null,
      });

      validatedRows.push({
        rowIndex: index,
        productName,
        variantName,
        categoryName,
        description: row.description?.trim() || null,
        status,
        sku: row.sku?.trim() || null,
        barcode: row.barcode?.trim() || null,
        price,
        cost,
        minPrice,
        vatMode,
        baseUnitId,
        sellUnitId,
        conversionFactor,
        trackStock,
        branchNames,
      });
    }

    // Second pass: apply — group by product_name and create product + variants
    if (apply) {
      // Group validated rows by product_name
      const productGroups = new Map<string, ValidatedRow[]>();
      for (const vr of validatedRows) {
        const key = vr.productName.toLowerCase();
        if (!productGroups.has(key)) {
          productGroups.set(key, []);
        }
        productGroups.get(key)!.push(vr);
      }

      for (const [, group] of productGroups) {
        const first = group[0];
        // Check if product already exists (for multi-variant imports of same product)
        if (productNames.has(first.productName.toLowerCase())) {
          for (const vr of group) {
            errors.push({
              row: vr.rowIndex + 2,
              message: 'Product name already exists.',
            });
          }
          continue;
        }

        try {
          await this.prisma.$transaction(async (tx) => {
            // Resolve or create category using the first row's category
            const categoryName = first.categoryName;
            let categoryRecord = await tx.category.findFirst({
              where: { businessId, name: categoryName },
            });
            if (!categoryRecord && !allowCreateCategory) {
              throw new BadRequestException('Category does not exist.');
            }
            if (!categoryRecord) {
              categoryRecord = await tx.category.create({
                data: {
                  businessId,
                  name: categoryName,
                  status: RecordStatus.ACTIVE,
                },
              });
            }

            // Create the product once
            const product = await tx.product.create({
              data: {
                businessId,
                name: first.productName,
                description: first.description,
                status: first.status as RecordStatus,
                categoryId: categoryRecord.id,
              },
            });

            // Create each variant
            for (const vr of group) {
              const variant = await tx.variant.create({
                data: {
                  businessId,
                  productId: product.id,
                  name: vr.variantName,
                  sku: vr.sku,
                  defaultPrice:
                    vr.price !== null ? new Prisma.Decimal(vr.price) : null,
                  defaultCost:
                    vr.cost !== null ? new Prisma.Decimal(vr.cost) : null,
                  minPrice:
                    vr.minPrice !== null
                      ? new Prisma.Decimal(vr.minPrice)
                      : null,
                  vatMode: (vr.vatMode ?? 'INCLUSIVE') as VatMode,
                  status: vr.status as RecordStatus,
                  baseUnitId: vr.baseUnitId,
                  sellUnitId: vr.sellUnitId,
                  conversionFactor:
                    vr.conversionFactor !== null
                      ? new Prisma.Decimal(vr.conversionFactor)
                      : undefined,
                  trackStock: vr.trackStock,
                },
              });

              // Handle barcode
              if (vr.barcode) {
                try {
                  const barcode = await tx.barcode.create({
                    data: {
                      businessId,
                      variantId: variant.id,
                      code: vr.barcode,
                      isActive: true,
                    },
                  });
                } catch (barcodeErr) {
                  if (
                    barcodeErr instanceof
                      Prisma.PrismaClientKnownRequestError &&
                    barcodeErr.code === 'P2002'
                  ) {
                    throw new BadRequestException(
                      `Duplicate barcode: ${vr.barcode}`,
                    );
                  }
                  throw barcodeErr;
                }
              }

              // Handle branch availability
              if (vr.branchNames.length > 0) {
                const activeBranchIds = new Set(
                  vr.branchNames.map(
                    (bName) => branchNameMap.get(bName.toLowerCase())!.id,
                  ),
                );
                for (const branch of allBranches) {
                  if (!activeBranchIds.has(branch.id)) {
                    await tx.branchVariantAvailability.upsert({
                      where: {
                        businessId_branchId_variantId: {
                          businessId,
                          branchId: branch.id,
                          variantId: variant.id,
                        },
                      },
                      create: {
                        businessId,
                        branchId: branch.id,
                        variantId: variant.id,
                        isActive: false,
                      },
                      update: {
                        isActive: false,
                      },
                    });
                  }
                }
              }
            }
          });
          productNames.add(first.productName.toLowerCase());
        } catch (rowErr) {
          if (rowErr instanceof BadRequestException) {
            for (const vr of group) {
              errors.push({
                row: vr.rowIndex + 2,
                message: (rowErr as BadRequestException).message,
              });
            }
            continue;
          }
          throw rowErr;
        }
      }
    }

    return {
      validRows: preview.length,
      invalidRows: errors.length,
      errors,
      preview,
    };
  }

  private async validateOpeningStock(
    businessId: string,
    headers: string[],
    rows: Record<string, string>[],
    apply: boolean,
    userId?: string,
  ): Promise<PreviewResult> {
    const errors: { row: number; message: string }[] = [];
    const preview: Record<string, unknown>[] = [];

    // Detect format: legacy (branch_name + quantity columns) vs dynamic (one column per branch)
    const isLegacyFormat = headers.includes('quantity');

    // Pre-load all branches for the business
    const allBranches = await this.prisma.branch.findMany({
      where: { businessId },
    });
    const branchNameMap = new Map(
      allBranches.map((b) => [b.name.toLowerCase(), b]),
    );

    // Identify branch columns in dynamic format
    const knownHeaders = new Set([
      'sku', 'variant_id', 'product_name', 'variant_name',
      'batch_id', 'expiry_date', 'unit_cost',
      'quantity', 'branch_name', 'branch_id',
    ]);
    const branchColumns: { header: string; branchId: string }[] = [];
    if (!isLegacyFormat) {
      for (const h of headers) {
        if (knownHeaders.has(h)) continue;
        const branch = branchNameMap.get(h.toLowerCase());
        if (branch) {
          branchColumns.push({ header: h, branchId: branch.id });
        }
      }
      if (branchColumns.length === 0) {
        throw new BadRequestException(
          'No branch columns found. Use your branch names as column headers with quantities as values.',
        );
      }
    }

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];

      // Resolve variant: by variant_id, SKU, or product_name + variant_name
      const { variant, error: variantError } = await this.resolveVariant(
        businessId, row, index + 2,
      );
      if (!variant) {
        errors.push({ row: index + 2, message: variantError! });
        continue;
      }
      const variantId = variant.id;

      const batchCode = row.batch_id?.trim() || null;
      const expiryDate = row.expiry_date?.trim() || null;
      if (expiryDate && Number.isNaN(Date.parse(expiryDate))) {
        errors.push({ row: index + 2, message: 'Invalid expiry_date.' });
        continue;
      }
      const unitCost = row.unit_cost ? this.parseNumber(row.unit_cost) : null;
      if (row.unit_cost && (unitCost === null || unitCost < 0)) {
        errors.push({ row: index + 2, message: 'Invalid unit_cost.' });
        continue;
      }

      // Build list of (branchId, quantity) entries for this row
      const branchEntries: { branchId: string; quantity: number }[] = [];

      if (isLegacyFormat) {
        // Legacy: single branch_name/branch_id + quantity per row
        const quantity = this.parseNumber(row.quantity ?? '');
        if (quantity === null || quantity <= 0) {
          errors.push({ row: index + 2, message: 'Invalid quantity.' });
          continue;
        }
        let branchId = row.branch_id?.trim() || null;
        if (!branchId && row.branch_name?.trim()) {
          const branch = branchNameMap.get(row.branch_name.trim().toLowerCase());
          if (!branch) {
            errors.push({
              row: index + 2,
              message: `Branch not found: ${row.branch_name.trim()}`,
            });
            continue;
          }
          branchId = branch.id;
        }
        if (!branchId) {
          errors.push({
            row: index + 2,
            message: 'Either branch_id or branch_name is required.',
          });
          continue;
        }
        const branch = allBranches.find((b) => b.id === branchId);
        if (!branch) {
          errors.push({ row: index + 2, message: 'Branch not found.' });
          continue;
        }
        branchEntries.push({ branchId, quantity });
      } else {
        // Dynamic: one column per branch, quantity as value
        for (const col of branchColumns) {
          const cellValue = row[col.header]?.trim();
          if (!cellValue) continue; // empty = skip this branch
          const quantity = this.parseNumber(cellValue);
          if (quantity === null || quantity <= 0) {
            errors.push({
              row: index + 2,
              message: `Invalid quantity for branch "${col.header}".`,
            });
            continue;
          }
          branchEntries.push({ branchId: col.branchId, quantity });
        }
        if (branchEntries.length === 0) {
          errors.push({
            row: index + 2,
            message: 'No branch quantities provided.',
          });
          continue;
        }
      }

      // Process each branch entry
      for (const entry of branchEntries) {
        const { branchId, quantity } = entry;
        preview.push({
          variantId,
          branchId,
          quantity,
          batchCode,
          expiryDate,
          unitCost,
        });
        if (apply) {
          const txResult = await this.prisma
            .$transaction(async (tx) => {
              let batch: Awaited<
                ReturnType<typeof tx.batch.create>
              > | null = null;
              if (batchCode) {
                const existingBatch = await tx.batch.findFirst({
                  where: { businessId, branchId, variantId, code: batchCode },
                });
                if (existingBatch) {
                  throw Object.assign(new Error('BATCH_EXISTS'), {
                    row: index + 2,
                  });
                }
                batch = await tx.batch.create({
                  data: {
                    businessId,
                    branchId,
                    variantId,
                    code: batchCode,
                    expiryDate: expiryDate ? new Date(expiryDate) : null,
                    unitCost:
                      unitCost !== null
                        ? new Prisma.Decimal(unitCost)
                        : undefined,
                  },
                });
              }
              const movement = await tx.stockMovement.create({
                data: {
                  businessId,
                  branchId,
                  variantId,
                  createdById: userId,
                  batchId: batch?.id ?? null,
                  quantity: new Prisma.Decimal(quantity),
                  movementType: StockMovementType.OPENING_BALANCE,
                },
              });
              const snapshot = await tx.stockSnapshot.upsert({
                where: {
                  businessId_branchId_variantId: {
                    businessId,
                    branchId,
                    variantId,
                  },
                },
                create: {
                  businessId,
                  branchId,
                  variantId,
                  quantity: new Prisma.Decimal(quantity),
                },
                update: {
                  quantity: { increment: new Prisma.Decimal(quantity) },
                },
              });

              // Record stock cost as expense when unit_cost is provided
              let expense: { id: string } | null = null;
              const costPerUnit = unitCost !== null
                ? new Prisma.Decimal(unitCost)
                : (batch?.unitCost ?? null);
              if (costPerUnit) {
                const settings = await tx.businessSettings.findFirst({
                  where: { businessId },
                  select: { localeSettings: true },
                });
                const locale = (settings?.localeSettings as Record<string, unknown> | null) ?? {};
                const currency = String(locale.currency ?? 'TZS');
                expense = await tx.expense.create({
                  data: {
                    businessId,
                    branchId,
                    category: 'STOCK_COST',
                    amount: costPerUnit.mul(quantity),
                    currency,
                    note: `Opening stock import (row ${index + 2})`,
                    createdBy: userId,
                  },
                });
              }

              return { batch, movement, snapshot, expense };
            })
            .catch((err: Error & { row?: number }) => {
              if (err.message === 'BATCH_EXISTS') {
                errors.push({
                  row: err.row ?? index + 2,
                  message: 'Batch already exists.',
                });
                return null;
              }
              throw err;
            });

          if (!txResult) {
            continue;
          }

        }
      }
    }
    return {
      validRows: preview.length,
      invalidRows: errors.length,
      errors,
      preview,
    };
  }

  private async validatePriceUpdates(
    businessId: string,
    headers: string[],
    rows: Record<string, string>[],
    apply: boolean,
    userId?: string,
  ): Promise<PreviewResult> {
    this.ensureHeaders(headers, ['price']);
    const errors: { row: number; message: string }[] = [];
    const preview: Record<string, unknown>[] = [];
    let changedCount = 0;
    let unchangedCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const price = this.parseNumber(row.price ?? '');
      if (price === null || price < 0) {
        errors.push({ row: index + 2, message: 'Invalid price.' });
        continue;
      }

      // Resolve variant: by variant_id, SKU, or product_name + variant_name
      const { variant: resolvedVariant, error: variantError } = await this.resolveVariant(
        businessId, row, index + 2,
      );
      if (!resolvedVariant) {
        errors.push({ row: index + 2, message: variantError! });
        continue;
      }
      const variantId = resolvedVariant.id;

      const vatMode = row.vat_mode
        ? this.normalizeStatus(row.vat_mode, [
            'INCLUSIVE',
            'EXCLUSIVE',
            'EXEMPT',
          ])
        : null;
      if (row.vat_mode && !vatMode) {
        errors.push({ row: index + 2, message: 'Invalid vat_mode.' });
        continue;
      }

      // Validate min_price
      const minPrice = row.min_price ? this.parseNumber(row.min_price) : null;
      if (row.min_price && (minPrice === null || minPrice < 0)) {
        errors.push({ row: index + 2, message: 'Invalid min_price.' });
        continue;
      }

      const variant = await this.prisma.variant.findFirst({
        where: { id: variantId, businessId },
      });
      if (!variant) {
        errors.push({ row: index + 2, message: 'Variant not found.' });
        continue;
      }
      preview.push({
        variantId,
        price,
        minPrice,
        vatMode: vatMode ?? variant.vatMode,
      });
      if (apply) {
        const priceUnchanged =
          Number(variant.defaultPrice) === price &&
          (vatMode ?? variant.vatMode) === variant.vatMode &&
          (minPrice === null || Number(variant.minPrice) === minPrice);
        if (priceUnchanged) {
          unchangedCount++;
          continue;
        }
        changedCount++;
        await this.prisma.variant.updateMany({
          where: { id: variantId, businessId },
          data: {
            defaultPrice: new Prisma.Decimal(price),
            vatMode: (vatMode ?? variant.vatMode) as VatMode,
            minPrice:
              minPrice !== null ? new Prisma.Decimal(minPrice) : undefined,
          },
        });
      }
    }
    return {
      validRows: preview.length,
      invalidRows: errors.length,
      changedRows: changedCount,
      unchangedRows: unchangedCount,
      errors,
      preview,
    };
  }

  private async validateStatusUpdates(
    businessId: string,
    headers: string[],
    rows: Record<string, string>[],
    apply: boolean,
    userId?: string,
  ): Promise<PreviewResult> {
    this.ensureHeaders(headers, ['product_name', 'status']);
    const errors: { row: number; message: string }[] = [];
    const preview: Record<string, unknown>[] = [];
    let changedCount = 0;
    let unchangedCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const productName = row.product_name?.trim();
      const variantName = row.variant_name?.trim() || null;
      const status = this.normalizeStatus(row.status ?? '', [
        'ACTIVE',
        'INACTIVE',
        'ARCHIVED',
      ]);
      if (!productName || !status) {
        errors.push({
          row: index + 2,
          message: 'Invalid product_name or status.',
        });
        continue;
      }
      const product = await this.prisma.product.findFirst({
        where: { businessId, name: productName },
        include: { variants: true },
      });
      if (!product) {
        errors.push({ row: index + 2, message: 'Product not found.' });
        continue;
      }
      if (variantName) {
        const variant = product.variants.find(
          (item) => item.name === variantName,
        );
        if (!variant) {
          errors.push({
            row: index + 2,
            message: 'Variant not found for product.',
          });
          continue;
        }
      }
      preview.push({
        product: productName,
        variant: variantName,
        status,
      });
      if (apply) {
        if (variantName) {
          const variant = product.variants.find(
            (item) => item.name === variantName,
          );
          if (!variant) {
            continue;
          }
          if (variant.status === status) {
            unchangedCount++;
            continue;
          }
          changedCount++;
          await this.prisma.variant.updateMany({
            where: { id: variant.id, businessId },
            data: { status: status as RecordStatus },
          });
        } else {
          const allMatch =
            product.status === status &&
            product.variants.every((v) => v.status === status);
          if (allMatch) {
            unchangedCount++;
            continue;
          }
          changedCount++;
          await this.prisma.product.update({
            where: { id: product.id, businessId },
            data: { status: status as RecordStatus },
          });
          await this.prisma.variant.updateMany({
            where: { productId: product.id },
            data: { status: status as RecordStatus },
          });
        }
      }
    }
    return {
      validRows: preview.length,
      invalidRows: errors.length,
      changedRows: changedCount,
      unchangedRows: unchangedCount,
      errors,
      preview,
    };
  }

  private async validateSuppliers(
    businessId: string,
    headers: string[],
    rows: Record<string, string>[],
    apply: boolean,
    userId?: string,
  ): Promise<PreviewResult> {
    this.ensureHeaders(headers, ['name', 'status']);
    const errors: { row: number; message: string }[] = [];
    const preview: Record<string, unknown>[] = [];
    let changedCount = 0;
    let unchangedCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const name = row.name?.trim();
      const status = this.normalizeStatus(row.status ?? '', [
        'ACTIVE',
        'INACTIVE',
      ]);
      if (!name || !status) {
        errors.push({ row: index + 2, message: 'Invalid name or status.' });
        continue;
      }
      if (row.email && !row.email.includes('@')) {
        errors.push({ row: index + 2, message: 'Invalid email.' });
        continue;
      }

      // Validate lead_time_days
      const leadTimeDays = row.lead_time_days
        ? this.parseNumber(row.lead_time_days)
        : null;
      if (
        row.lead_time_days &&
        (leadTimeDays === null || leadTimeDays < 0)
      ) {
        errors.push({
          row: index + 2,
          message: 'Invalid lead_time_days.',
        });
        continue;
      }

      preview.push({
        name,
        status,
        phone: row.phone?.trim() || null,
        email: row.email?.trim() || null,
        address: row.address?.trim() || null,
        notes: row.notes?.trim() || null,
        leadTimeDays,
      });
      if (apply) {
        const existing = await this.prisma.supplier.findFirst({
          where: { businessId, name },
        });
        if (existing) {
          const newPhone = row.phone?.trim() || null;
          const newEmail = row.email?.trim() || null;
          const newAddress = row.address?.trim() || null;
          const newNotes = row.notes?.trim() || null;
          const supplierUnchanged =
            existing.status === status &&
            (existing.phone ?? null) === newPhone &&
            (existing.email ?? null) === newEmail &&
            (existing.address ?? null) === newAddress &&
            (existing.notes ?? null) === newNotes &&
            (leadTimeDays === null || existing.leadTimeDays === leadTimeDays);
          if (supplierUnchanged) {
            unchangedCount++;
            continue;
          }
          changedCount++;
          await this.prisma.supplier.update({
            where: { id: existing.id },
            data: {
              status: status as RecordStatus,
              phone: newPhone,
              email: newEmail,
              address: newAddress,
              notes: newNotes,
              leadTimeDays:
                leadTimeDays !== null ? leadTimeDays : undefined,
            },
          });
        } else {
          const created = await this.prisma.supplier.create({
            data: {
              businessId,
              name,
              status: status as RecordStatus,
              phone: row.phone?.trim() || null,
              email: row.email?.trim() || null,
              address: row.address?.trim() || null,
              notes: row.notes?.trim() || null,
              leadTimeDays:
                leadTimeDays !== null ? leadTimeDays : undefined,
            },
          });
        }
      }
    }
    return {
      validRows: preview.length,
      invalidRows: errors.length,
      changedRows: changedCount,
      unchangedRows: unchangedCount,
      errors,
      preview,
    };
  }

  private async validateBranches(
    businessId: string,
    headers: string[],
    rows: Record<string, string>[],
    apply: boolean,
    userId?: string,
  ): Promise<PreviewResult> {
    this.ensureHeaders(headers, ['name', 'status']);
    const errors: { row: number; message: string }[] = [];
    const preview: Record<string, unknown>[] = [];
    const existing = await this.prisma.branch.findMany({
      where: { businessId },
      select: { name: true },
    });
    const existingNames = new Set(
      existing.map((branch) => branch.name.toLowerCase()),
    );
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const name = row.name?.trim();
      const status = this.normalizeStatus(row.status ?? '', [
        'ACTIVE',
        'INACTIVE',
        'ARCHIVED',
      ]);
      if (!name || !status) {
        errors.push({ row: index + 2, message: 'Invalid name or status.' });
        continue;
      }
      if (existingNames.has(name.toLowerCase())) {
        errors.push({ row: index + 2, message: 'Branch name already exists.' });
        continue;
      }
      preview.push({
        name,
        status,
        address: row.address?.trim() || null,
        phone: row.phone?.trim() || null,
      });
      if (apply) {
        const created = await this.prisma.branch.create({
          data: {
            businessId,
            name,
            status: status as RecordStatus,
            address: row.address?.trim() || null,
            phone: row.phone?.trim() || null,
          },
        });
        existingNames.add(name.toLowerCase());
      }
    }
    return {
      validRows: preview.length,
      invalidRows: errors.length,
      errors,
      preview,
    };
  }

  private async validateUsers(
    businessId: string,
    headers: string[],
    rows: Record<string, string>[],
    apply: boolean,
    userId?: string,
  ): Promise<PreviewResult> {
    this.ensureHeaders(headers, ['name', 'email', 'role', 'status']);
    const errors: { row: number; message: string }[] = [];
    const preview: Record<string, unknown>[] = [];
    let changedCount = 0;
    let unchangedCount = 0;

    // Pre-load branches for validation
    const allBranches = await this.prisma.branch.findMany({
      where: { businessId },
    });
    const branchNameMap = new Map(
      allBranches.map((b) => [b.name.toLowerCase(), b]),
    );

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const name = row.name?.trim();
      const email = row.email?.trim();
      const roleName = row.role?.trim();
      const phone = row.phone?.trim() || null;
      const status = this.normalizeStatus(row.status ?? '', [
        'ACTIVE',
        'SUSPENDED',
        'DEACTIVATED',
        'PENDING',
      ]);
      if (!name || !email || !roleName || !status) {
        errors.push({
          row: index + 2,
          message: 'Missing required user fields.',
        });
        continue;
      }
      const role = await this.prisma.role.findFirst({
        where: { businessId, name: roleName },
      });
      if (!role) {
        errors.push({ row: index + 2, message: 'Role not found.' });
        continue;
      }

      // Resolve branches: support legacy (semicolon-separated names / comma-separated IDs)
      // and dynamic format (one column per branch with yes/true)
      let branchIds: string[] = [];
      if (row.branches?.trim()) {
        const branchNamesList = row.branches
          .split(';')
          .map((n) => n.trim())
          .filter((n) => n.length > 0);
        let branchError = false;
        for (const bName of branchNamesList) {
          const branch = branchNameMap.get(bName.toLowerCase());
          if (!branch) {
            errors.push({
              row: index + 2,
              message: `Branch not found: ${bName}`,
            });
            branchError = true;
            break;
          }
          branchIds.push(branch.id);
        }
        if (branchError) continue;
      } else if (row.branch_ids?.trim()) {
        branchIds = row.branch_ids
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id.length > 0);
        if (branchIds.length) {
          const count = await this.prisma.branch.count({
            where: { businessId, id: { in: branchIds } },
          });
          if (count !== branchIds.length) {
            errors.push({ row: index + 2, message: 'Invalid branch_ids.' });
            continue;
          }
        }
      } else {
        // Dynamic format: check for columns matching branch names with yes/true values
        for (const [lowerName, branch] of branchNameMap) {
          const matchingHeader = headers.find(
            (h) => h.toLowerCase() === lowerName,
          );
          if (!matchingHeader) continue;
          const cellValue = row[matchingHeader]?.trim().toLowerCase();
          if (cellValue === 'yes' || cellValue === 'true') {
            branchIds.push(branch.id);
          }
        }
      }

      preview.push({
        name,
        email,
        phone,
        role: roleName,
        status,
        branchIds,
      });
      if (apply) {
        let user = await this.prisma.user.findFirst({ where: { email } });
        if (!user) {
          user = await this.prisma.user.create({
            data: {
              name,
              email,
              phone,
              passwordHash: hashPassword(`Temp-${Date.now()}`),
              mustResetPassword: true,
            },
          });
        } else {
          const userUnchanged =
            user.name === name &&
            (user.phone ?? null) === phone;
          if (userUnchanged) {
            unchangedCount++;
          } else {
            changedCount++;
            user = await this.prisma.user.update({
              where: { id: user.id },
              data: { name, phone },
            });
          }
        }
        const membership = await this.prisma.businessUser.findFirst({
          where: { businessId, userId: user.id },
        });
        if (!membership) {
          await this.prisma.businessUser.create({
            data: { businessId, userId: user.id, status: status as UserStatus },
          });
        } else {
          await this.prisma.businessUser.update({
            where: { id: membership.id },
            data: { status: status as UserStatus },
          });
        }
        if (branchIds.length) {
          for (const branchId of branchIds) {
            const existingRole = await this.prisma.userRole.findFirst({
              where: { userId: user.id, roleId: role.id, branchId },
            });
            if (!existingRole) {
              const userRole = await this.prisma.userRole.create({
                data: { userId: user.id, roleId: role.id, branchId },
              });
            }
          }
        } else {
          const existingRole = await this.prisma.userRole.findFirst({
            where: { userId: user.id, roleId: role.id, branchId: null },
          });
          if (!existingRole) {
            const userRole = await this.prisma.userRole.create({
              data: { userId: user.id, roleId: role.id, branchId: null },
            });
          }
        }
      }
    }
    return {
      validRows: preview.length,
      invalidRows: errors.length,
      changedRows: changedCount,
      unchangedRows: unchangedCount,
      errors,
      preview,
    };
  }

  private async validateCustomers(
    businessId: string,
    headers: string[],
    rows: Record<string, string>[],
    apply: boolean,
    userId?: string,
  ): Promise<PreviewResult> {
    this.ensureHeaders(headers, ['name', 'status']);
    const errors: { row: number; message: string }[] = [];
    const preview: Record<string, unknown>[] = [];
    let changedCount = 0;
    let unchangedCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const name = row.name?.trim();
      const status = this.normalizeStatus(row.status ?? '', [
        'ACTIVE',
        'INACTIVE',
        'ARCHIVED',
      ]);
      if (!name || !status) {
        errors.push({ row: index + 2, message: 'Invalid name or status.' });
        continue;
      }
      if (row.email?.trim() && !row.email.includes('@')) {
        errors.push({ row: index + 2, message: 'Invalid email.' });
        continue;
      }
      preview.push({
        name,
        status,
        phone: row.phone?.trim() || null,
        email: row.email?.trim() || null,
        tin: row.tin?.trim() || null,
        notes: row.notes?.trim() || null,
      });
      if (apply) {
        const existing = await this.prisma.customer.findFirst({
          where: { businessId, name },
        });
        if (existing) {
          const newPhone = row.phone?.trim() || null;
          const newEmail = row.email?.trim() || null;
          const newTin = row.tin?.trim() || null;
          const newNotes = row.notes?.trim() || null;
          const customerUnchanged =
            existing.status === status &&
            (existing.phone ?? null) === newPhone &&
            (existing.email ?? null) === newEmail &&
            (existing.tin ?? null) === newTin &&
            (existing.notes ?? null) === newNotes;
          if (customerUnchanged) {
            unchangedCount++;
            continue;
          }
          changedCount++;
          await this.prisma.customer.update({
            where: { id: existing.id },
            data: {
              status: status as RecordStatus,
              phone: newPhone,
              email: newEmail,
              tin: newTin,
              notes: newNotes,
            },
          });
        } else {
          const created = await this.prisma.customer.create({
            data: {
              businessId,
              name,
              status: status as RecordStatus,
              phone: row.phone?.trim() || null,
              email: row.email?.trim() || null,
              tin: row.tin?.trim() || null,
              notes: row.notes?.trim() || null,
            },
          });
        }
      }
    }
    return {
      validRows: preview.length,
      invalidRows: errors.length,
      changedRows: changedCount,
      unchangedRows: unchangedCount,
      errors,
      preview,
    };
  }

  private async validateUnits(
    businessId: string,
    headers: string[],
    rows: Record<string, string>[],
    apply: boolean,
    userId?: string,
  ): Promise<PreviewResult> {
    this.ensureHeaders(headers, ['code', 'label']);
    const errors: { row: number; message: string }[] = [];
    const preview: Record<string, unknown>[] = [];
    const validUnitTypes = ['COUNT', 'WEIGHT', 'VOLUME', 'LENGTH', 'OTHER'];

    // Pre-load existing unit codes for this business
    const existingUnits = await this.prisma.unit.findMany({
      where: { businessId },
      select: { code: true },
    });
    const existingCodes = new Set(
      existingUnits.map((u) => u.code.toLowerCase()),
    );

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const code = row.code?.trim();
      const label = row.label?.trim();
      if (!code || !label) {
        errors.push({
          row: index + 2,
          message: 'Missing code or label.',
        });
        continue;
      }

      // Validate unit_type
      let unitType = 'COUNT';
      if (row.unit_type?.trim()) {
        const normalized = row.unit_type.trim().toUpperCase();
        if (!validUnitTypes.includes(normalized)) {
          errors.push({
            row: index + 2,
            message: `Invalid unit_type. Must be one of: ${validUnitTypes.join(', ')}`,
          });
          continue;
        }
        unitType = normalized;
      }

      // Check for duplicate code
      if (existingCodes.has(code.toLowerCase())) {
        errors.push({
          row: index + 2,
          message: 'Unit code already exists.',
        });
        continue;
      }

      preview.push({
        code,
        label,
        unitType,
      });

      // Track code within this import to catch duplicates within the CSV
      existingCodes.add(code.toLowerCase());

      if (apply) {
        const created = await this.prisma.unit.create({
          data: {
            businessId,
            code,
            label,
            unitType: unitType as UnitType,
          },
        });
      }
    }
    return {
      validRows: preview.length,
      invalidRows: errors.length,
      errors,
      preview,
    };
  }

  private async validateStockCounts(
    businessId: string,
    headers: string[],
    rows: Record<string, string>[],
    apply: boolean,
    userId?: string,
  ): Promise<PreviewResult> {
    const errors: { row: number; message: string }[] = [];
    const preview: Record<string, unknown>[] = [];

    // Detect format: legacy (branch_name + counted_quantity) vs dynamic (one column per branch)
    const isLegacyFormat = headers.includes('counted_quantity');

    // Pre-load all branches for the business
    const allBranches = await this.prisma.branch.findMany({
      where: { businessId },
    });
    const branchNameMap = new Map(
      allBranches.map((b) => [b.name.toLowerCase(), b]),
    );

    // Identify branch columns in dynamic format
    const knownHeaders = new Set([
      'sku', 'variant_id', 'product_name', 'variant_name',
      'reason', 'counted_quantity', 'branch_name', 'branch_id',
    ]);
    const branchColumns: { header: string; branchId: string; branchName: string }[] = [];
    if (!isLegacyFormat) {
      for (const h of headers) {
        if (knownHeaders.has(h)) continue;
        const branch = branchNameMap.get(h.toLowerCase());
        if (branch) {
          branchColumns.push({ header: h, branchId: branch.id, branchName: branch.name });
        }
      }
      if (branchColumns.length === 0) {
        throw new BadRequestException(
          'No branch columns found. Use your branch names as column headers with counted quantities as values.',
        );
      }
    }

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];

      // Resolve variant: by variant_id, SKU, or product_name + variant_name
      const { variant, error: variantError } = await this.resolveVariant(
        businessId, row, index + 2,
      );
      if (!variant) {
        errors.push({ row: index + 2, message: variantError! });
        continue;
      }

      const reason = row.reason?.trim() || null;

      // Build list of (branchId, branchName, countedQuantity) entries
      const branchEntries: { branchId: string; branchName: string; countedQuantity: number }[] = [];

      if (isLegacyFormat) {
        const countedQuantity = this.parseNumber(row.counted_quantity ?? '');
        if (countedQuantity === null || countedQuantity < 0) {
          errors.push({ row: index + 2, message: 'Invalid counted_quantity.' });
          continue;
        }
        const branchId = row.branch_id?.trim() || null;
        const branchName = row.branch_name?.trim() || null;
        if (!branchId && !branchName) {
          errors.push({ row: index + 2, message: 'Provide branch_id or branch_name.' });
          continue;
        }
        const branch = branchId
          ? allBranches.find((b) => b.id === branchId)
          : branchName
            ? branchNameMap.get(branchName.toLowerCase())
            : null;
        if (!branch) {
          errors.push({ row: index + 2, message: 'Branch not found.' });
          continue;
        }
        branchEntries.push({ branchId: branch.id, branchName: branch.name, countedQuantity });
      } else {
        for (const col of branchColumns) {
          const cellValue = row[col.header]?.trim();
          if (!cellValue) continue;
          const countedQuantity = this.parseNumber(cellValue);
          if (countedQuantity === null || countedQuantity < 0) {
            errors.push({
              row: index + 2,
              message: `Invalid quantity for branch "${col.header}".`,
            });
            continue;
          }
          branchEntries.push({
            branchId: col.branchId,
            branchName: col.branchName,
            countedQuantity,
          });
        }
        if (branchEntries.length === 0) {
          errors.push({
            row: index + 2,
            message: 'No branch quantities provided.',
          });
          continue;
        }
      }

      for (const entry of branchEntries) {
        const { branchId, branchName, countedQuantity } = entry;

        preview.push({
          variantId: variant.id,
          variantName: variant.name,
          branchId,
          branchName,
          countedQuantity,
          reason,
        });

        if (apply) {
          const snapshot = await this.prisma.stockSnapshot.findFirst({
            where: { businessId, branchId, variantId: variant.id },
          });
          const expectedQuantity = snapshot ? Number(snapshot.quantity) : 0;
          const variance = countedQuantity - expectedQuantity;
          const varianceQuantity = new Prisma.Decimal(variance);

          const txResult = await this.prisma.$transaction(async (tx) => {
            const movement = await tx.stockMovement.create({
              data: {
                businessId,
                branchId,
                variantId: variant.id,
                createdById: userId,
                quantity: varianceQuantity,
                movementType: StockMovementType.STOCK_COUNT_VARIANCE,
                reason,
              },
            });
            const updatedSnapshot = await tx.stockSnapshot.upsert({
              where: {
                businessId_branchId_variantId: {
                  businessId,
                  branchId,
                  variantId: variant.id,
                },
              },
              create: {
                businessId,
                branchId,
                variantId: variant.id,
                quantity: new Prisma.Decimal(countedQuantity),
              },
              update: {
                quantity: new Prisma.Decimal(countedQuantity),
              },
            });
            return { movement, updatedSnapshot };
          });

        }
      }
    }
    return {
      validRows: preview.length,
      invalidRows: errors.length,
      errors,
      preview,
    };
  }
}
