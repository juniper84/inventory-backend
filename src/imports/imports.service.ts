import { BadRequestException, Injectable } from '@nestjs/common';
import {
  Prisma,
  RecordStatus,
  UserStatus,
  VatMode,
  StockMovementType,
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
  | 'users';

type PreviewResult = {
  validRows: number;
  invalidRows: number;
  errors: { row: number; message: string }[];
  preview: Record<string, unknown>[];
};

@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

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
        partial: validation.invalidRows > 0,
      },
    });
    return validation;
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
    const existing = await this.prisma.category.findMany({
      where: { businessId },
      select: { id: true, name: true },
    });
    const existingMap = new Map(
      existing.map((category) => [
        this.normalizeName(category.name),
        category.id,
      ]),
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
          const before = await this.prisma.category.findFirst({
            where: { id: existingId, businessId },
          });
          const updated = await this.prisma.category.update({
            where: { id: existingId },
            data: { status: status as RecordStatus, parentId },
          });
          await this.logImportEvent({
            businessId,
            userId,
            action: 'CATEGORY_UPDATE',
            resourceType: 'Category',
            resourceId: existingId,
            metadata: {
              resourceName: name,
              importType: 'categories',
              row: index + 2,
            },
            before: (before ?? undefined) as unknown as Record<string, unknown>,
            after: updated as unknown as Record<string, unknown>,
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
          await this.logImportEvent({
            businessId,
            userId,
            action: 'CATEGORY_CREATE',
            resourceType: 'Category',
            resourceId: created.id,
            metadata: {
              resourceName: name,
              importType: 'categories',
              row: index + 2,
            },
            after: created as unknown as Record<string, unknown>,
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

  private parseNumber(value: string) {
    const num = Number(value);
    if (Number.isNaN(num)) {
      return null;
    }
    return num;
  }

  private async validateProducts(
    businessId: string,
    headers: string[],
    rows: Record<string, string>[],
    options: { createMissingCategories?: boolean } | undefined,
    apply: boolean,
    userId?: string,
  ): Promise<PreviewResult> {
    this.ensureHeaders(headers, ['name', 'category', 'status']);
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
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const name = row.name?.trim();
      const categoryName = row.category?.trim();
      const status = this.normalizeStatus(row.status ?? '', [
        'ACTIVE',
        'INACTIVE',
        'ARCHIVED',
      ]);
      if (!name || !categoryName || !status) {
        errors.push({
          row: index + 2,
          message: 'Missing name, category, or invalid status.',
        });
        continue;
      }
      if (productNames.has(name.toLowerCase())) {
        errors.push({
          row: index + 2,
          message: 'Product name already exists.',
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
      preview.push({
        name,
        category: categoryName,
        status,
        sku: row.sku?.trim() || null,
        barcode: row.barcode?.trim() || null,
        price,
        cost,
        vatMode,
      });
      if (apply) {
        const category = await this.prisma.category.findFirst({
          where: { businessId, name: categoryName },
        });
        if (!category && !allowCreateCategory) {
          errors.push({ row: index + 2, message: 'Category does not exist.' });
          continue;
        }
        let categoryRecord = category;
        if (!categoryRecord) {
          categoryRecord = await this.prisma.category.create({
            data: {
              businessId,
              name: categoryName,
              status: RecordStatus.ACTIVE,
            },
          });
          await this.logImportEvent({
            businessId,
            userId,
            action: 'CATEGORY_CREATE',
            resourceType: 'Category',
            resourceId: categoryRecord.id,
            metadata: {
              resourceName: categoryName,
              importType: 'products',
              row: index + 2,
            },
            after: categoryRecord as unknown as Record<string, unknown>,
          });
        }
        const product = await this.prisma.product.create({
          data: {
            businessId,
            name,
            description: row.description?.trim() || null,
            status: status as RecordStatus,
            categoryId: categoryRecord.id,
          },
        });
        await this.logImportEvent({
          businessId,
          userId,
          action: 'PRODUCT_CREATE',
          resourceType: 'Product',
          resourceId: product.id,
          metadata: {
            resourceName: name,
            categoryId: categoryRecord.id,
            importType: 'products',
            row: index + 2,
          },
          after: product as unknown as Record<string, unknown>,
        });
        const variant = await this.prisma.variant.create({
          data: {
            businessId,
            productId: product.id,
            name,
            sku: row.sku?.trim() || null,
            defaultPrice: price !== null ? new Prisma.Decimal(price) : null,
            defaultCost: cost !== null ? new Prisma.Decimal(cost) : null,
            vatMode: (vatMode ?? 'INCLUSIVE') as VatMode,
            status: status as RecordStatus,
          },
        });
        await this.logImportEvent({
          businessId,
          userId,
          action: 'VARIANT_CREATE',
          resourceType: 'Variant',
          resourceId: variant.id,
          metadata: {
            resourceName: name,
            productId: product.id,
            importType: 'products',
            row: index + 2,
          },
          after: variant as unknown as Record<string, unknown>,
        });
        if (row.barcode?.trim()) {
          const barcode = await this.prisma.barcode.create({
            data: {
              businessId,
              variantId: variant.id,
              code: row.barcode.trim(),
              isActive: true,
            },
          });
          await this.logImportEvent({
            businessId,
            userId,
            action: 'BARCODE_CREATE',
            resourceType: 'Barcode',
            resourceId: barcode.id,
            metadata: {
              resourceName: barcode.code,
              variantId: variant.id,
              importType: 'products',
              row: index + 2,
            },
            after: barcode as unknown as Record<string, unknown>,
          });
        }
        productNames.add(name.toLowerCase());
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
    this.ensureHeaders(headers, ['variant_id', 'branch_id', 'quantity']);
    const errors: { row: number; message: string }[] = [];
    const preview: Record<string, unknown>[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const variantId = row.variant_id?.trim();
      const branchId = row.branch_id?.trim();
      const quantity = this.parseNumber(row.quantity ?? '');
      if (!variantId || !branchId || quantity === null || quantity <= 0) {
        errors.push({
          row: index + 2,
          message: 'Invalid variant, branch, or quantity.',
        });
        continue;
      }
      const variant = await this.prisma.variant.findFirst({
        where: { id: variantId, businessId },
      });
      const branch = await this.prisma.branch.findFirst({
        where: { id: branchId, businessId },
      });
      if (!variant || !branch) {
        errors.push({
          row: index + 2,
          message: 'Variant or branch not found.',
        });
        continue;
      }
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
      preview.push({
        variantId,
        branchId,
        quantity,
        batchCode,
        expiryDate,
        unitCost,
      });
      if (apply) {
        let batchId: string | null = null;
        if (batchCode) {
          const existingBatch = await this.prisma.batch.findFirst({
            where: {
              businessId,
              branchId,
              variantId,
              code: batchCode,
            },
          });
          if (existingBatch) {
            errors.push({ row: index + 2, message: 'Batch already exists.' });
            continue;
          }
          const batch = await this.prisma.batch.create({
            data: {
              businessId,
              branchId,
              variantId,
              code: batchCode,
              expiryDate: expiryDate ? new Date(expiryDate) : null,
            },
          });
          batchId = batch.id;
          await this.logImportEvent({
            businessId,
            userId,
            action: 'BATCH_CREATE',
            resourceType: 'Batch',
            resourceId: batch.id,
            metadata: {
              resourceName: batch.code,
              variantId,
              branchId,
              importType: 'opening_stock',
              row: index + 2,
            },
            after: batch as unknown as Record<string, unknown>,
          });
        }
        const movement = await this.prisma.stockMovement.create({
          data: {
            businessId,
            branchId,
            variantId,
            createdById: userId,
            batchId,
            quantity: new Prisma.Decimal(quantity),
            movementType: StockMovementType.OPENING_BALANCE,
          },
        });
        await this.logImportEvent({
          businessId,
          userId,
          action: 'STOCK_MOVEMENT_CREATE',
          resourceType: 'StockMovement',
          resourceId: movement.id,
          metadata: {
            variantId,
            branchId,
            batchId,
            quantity,
            importType: 'opening_stock',
            row: index + 2,
          },
          after: movement as unknown as Record<string, unknown>,
        });
        const snapshot = await this.prisma.stockSnapshot.upsert({
          where: {
            businessId_branchId_variantId: { businessId, branchId, variantId },
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
        await this.logImportEvent({
          businessId,
          userId,
          action: 'STOCK_SNAPSHOT_UPDATE',
          resourceType: 'StockSnapshot',
          resourceId: snapshot.id,
          metadata: {
            variantId,
            branchId,
            importType: 'opening_stock',
            row: index + 2,
          },
          after: snapshot as unknown as Record<string, unknown>,
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

  private async validatePriceUpdates(
    businessId: string,
    headers: string[],
    rows: Record<string, string>[],
    apply: boolean,
    userId?: string,
  ): Promise<PreviewResult> {
    this.ensureHeaders(headers, ['variant_id', 'price']);
    const errors: { row: number; message: string }[] = [];
    const preview: Record<string, unknown>[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const variantId = row.variant_id?.trim();
      const price = this.parseNumber(row.price ?? '');
      if (!variantId || price === null || price < 0) {
        errors.push({ row: index + 2, message: 'Invalid variant or price.' });
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
      const variant = await this.prisma.variant.findFirst({
        where: { id: variantId, businessId },
      });
      if (!variant) {
        errors.push({ row: index + 2, message: 'Variant not found.' });
        continue;
      }
      preview.push({ variantId, price, vatMode: vatMode ?? variant.vatMode });
      if (apply) {
        const updated = await this.prisma.variant.update({
          where: { id: variantId },
          data: {
            defaultPrice: new Prisma.Decimal(price),
            vatMode: (vatMode ?? variant.vatMode) as VatMode,
          },
        });
        await this.logImportEvent({
          businessId,
          userId,
          action: 'VARIANT_UPDATE',
          resourceType: 'Variant',
          resourceId: variantId,
          metadata: {
            resourceName: variant.name,
            importType: 'price_updates',
            row: index + 2,
          },
          before: variant as unknown as Record<string, unknown>,
          after: updated as unknown as Record<string, unknown>,
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
          const updated = await this.prisma.variant.update({
            where: { id: variant.id },
            data: { status: status as RecordStatus },
          });
          await this.logImportEvent({
            businessId,
            userId,
            action: 'VARIANT_UPDATE',
            resourceType: 'Variant',
            resourceId: variant.id,
            metadata: {
              resourceName: variant.name,
              productId: product.id,
              importType: 'status_updates',
              row: index + 2,
            },
            before: variant as unknown as Record<string, unknown>,
            after: updated as unknown as Record<string, unknown>,
          });
        } else {
          const updatedProduct = await this.prisma.product.update({
            where: { id: product.id },
            data: { status: status as RecordStatus },
          });
          await this.prisma.variant.updateMany({
            where: { productId: product.id },
            data: { status: status as RecordStatus },
          });
          await this.logImportEvent({
            businessId,
            userId,
            action: 'PRODUCT_UPDATE',
            resourceType: 'Product',
            resourceId: product.id,
            metadata: {
              resourceName: product.name,
              importType: 'status_updates',
              row: index + 2,
            },
            before: product as unknown as Record<string, unknown>,
            after: updatedProduct as unknown as Record<string, unknown>,
          });
          for (const variant of product.variants) {
            await this.logImportEvent({
              businessId,
              userId,
              action: 'VARIANT_UPDATE',
              resourceType: 'Variant',
              resourceId: variant.id,
              metadata: {
                resourceName: variant.name,
                productId: product.id,
                importType: 'status_updates',
                row: index + 2,
              },
              before: variant as unknown as Record<string, unknown>,
              after: {
                ...variant,
                status: status as RecordStatus,
              } as unknown as Record<string, unknown>,
            });
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
      preview.push({
        name,
        status,
        phone: row.phone?.trim() || null,
        email: row.email?.trim() || null,
        address: row.address?.trim() || null,
        notes: row.notes?.trim() || null,
      });
      if (apply) {
        const existing = await this.prisma.supplier.findFirst({
          where: { businessId, name },
        });
        if (existing) {
          const updated = await this.prisma.supplier.update({
            where: { id: existing.id },
            data: {
              status: status as RecordStatus,
              phone: row.phone?.trim() || null,
              email: row.email?.trim() || null,
              address: row.address?.trim() || null,
              notes: row.notes?.trim() || null,
            },
          });
          await this.logImportEvent({
            businessId,
            userId,
            action: 'SUPPLIER_UPDATE',
            resourceType: 'Supplier',
            resourceId: existing.id,
            metadata: {
              resourceName: name,
              importType: 'suppliers',
              row: index + 2,
            },
            before: existing as unknown as Record<string, unknown>,
            after: updated as unknown as Record<string, unknown>,
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
            },
          });
          await this.logImportEvent({
            businessId,
            userId,
            action: 'SUPPLIER_CREATE',
            resourceType: 'Supplier',
            resourceId: created.id,
            metadata: {
              resourceName: name,
              importType: 'suppliers',
              row: index + 2,
            },
            after: created as unknown as Record<string, unknown>,
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
        await this.logImportEvent({
          businessId,
          userId,
          action: 'BRANCH_CREATE',
          resourceType: 'Branch',
          resourceId: created.id,
          metadata: {
            resourceName: name,
            importType: 'branches',
            row: index + 2,
          },
          after: created as unknown as Record<string, unknown>,
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
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const name = row.name?.trim();
      const email = row.email?.trim();
      const roleName = row.role?.trim();
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
      const branchIds = row.branch_ids
        ? row.branch_ids
            .split(',')
            .map((id) => id.trim())
            .filter((id) => id.length > 0)
        : [];
      if (branchIds.length) {
        const count = await this.prisma.branch.count({
          where: { businessId, id: { in: branchIds } },
        });
        if (count !== branchIds.length) {
          errors.push({ row: index + 2, message: 'Invalid branch_ids.' });
          continue;
        }
      }
      preview.push({
        name,
        email,
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
              passwordHash: hashPassword(`Temp-${Date.now()}`),
              mustResetPassword: true,
              status: status as UserStatus,
            },
          });
          await this.logImportEvent({
            businessId,
            userId,
            action: 'USER_CREATE',
            resourceType: 'User',
            resourceId: user.id,
            metadata: {
              resourceName: name,
              importType: 'users',
              row: index + 2,
            },
            after: user as unknown as Record<string, unknown>,
          });
        } else {
          const updated = await this.prisma.user.update({
            where: { id: user.id },
            data: { name, status: status as UserStatus },
          });
          await this.logImportEvent({
            businessId,
            userId,
            action: 'USER_UPDATE',
            resourceType: 'User',
            resourceId: user.id,
            metadata: {
              resourceName: name,
              importType: 'users',
              row: index + 2,
            },
            before: user as unknown as Record<string, unknown>,
            after: updated as unknown as Record<string, unknown>,
          });
          user = updated;
        }
        const membership = await this.prisma.businessUser.findFirst({
          where: { businessId, userId: user.id },
        });
        if (!membership) {
          await this.prisma.businessUser.create({
            data: { businessId, userId: user.id, status: status as UserStatus },
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
              await this.logImportEvent({
                businessId,
                userId,
                action: 'USER_ROLE_ASSIGN',
                resourceType: 'UserRole',
                resourceId: userRole.id,
                metadata: {
                  userId: user.id,
                  roleId: role.id,
                  branchId,
                  importType: 'users',
                  row: index + 2,
                },
                after: userRole as unknown as Record<string, unknown>,
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
            await this.logImportEvent({
              businessId,
              userId,
              action: 'USER_ROLE_ASSIGN',
              resourceType: 'UserRole',
              resourceId: userRole.id,
              metadata: {
                userId: user.id,
                roleId: role.id,
                branchId: null,
                importType: 'users',
                row: index + 2,
              },
              after: userRole as unknown as Record<string, unknown>,
            });
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
}
