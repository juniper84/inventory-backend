import { BadRequestException, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { StorageService } from '../storage/storage.service';
import { Prisma, SubscriptionTier } from '@prisma/client';
import { UnitsService } from '../units/units.service';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly subscriptionService: SubscriptionService,
    private readonly approvalsService: ApprovalsService,
    private readonly storageService: StorageService,
    private readonly unitsService: UnitsService,
  ) {}

  async listCategories(
    businessId: string,
    query: PaginationQuery & { search?: string; status?: string },
  ) {
    const pagination = parsePagination(query);
    const search = query.search?.trim();
    const items = await this.prisma.category.findMany({
      where: {
        businessId,
        ...(query.status ? { status: query.status as any } : {}),
        ...(search
          ? { name: { contains: search, mode: Prisma.QueryMode.insensitive } }
          : {}),
      },
      include: {
        _count: { select: { products: true } },
      },
      orderBy: { createdAt: 'desc' },
      ...pagination,
    });
    return buildPaginatedResponse(items, pagination.take);
  }

  async createCategory(
    businessId: string,
    userId: string,
    data: { name: string; parentId?: string },
  ) {
    if (data.parentId) {
      const parent = await this.prisma.category.findFirst({
        where: { id: data.parentId, businessId },
      });
      if (!parent) {
        return null;
      }
    }
    const result = await this.prisma.category.create({
      data: {
        businessId,
        name: data.name,
        parentId: data.parentId,
      },
    });
    this.auditService.logEvent({
      businessId,
      userId,
      action: 'CATEGORY_CREATE',
      resourceType: 'Category',
      resourceId: result.id,
      outcome: 'SUCCESS',
      metadata: data,
    });
    return result;
  }

  async updateCategory(
    businessId: string,
    categoryId: string,
    userId: string,
    data: { name?: string; parentId?: string },
  ) {
    const before = await this.prisma.category.findFirst({
      where: { id: categoryId, businessId },
    });
    if (!before) {
      return null;
    }
    // Guard against circular parent references: walk up from the candidate
    // parent and ensure we never reach categoryId.
    if (data.parentId) {
      if (data.parentId === categoryId) {
        throw new BadRequestException('A category cannot be its own parent.');
      }
      let cursor: string | null = data.parentId;
      const seen = new Set<string>();
      while (cursor) {
        if (seen.has(cursor)) break; // cycle in existing data — stop walking
        seen.add(cursor);
        // eslint-disable-next-line no-await-in-loop
        const ancestor = await this.prisma.category.findFirst({
          where: { id: cursor, businessId },
          select: { id: true, parentId: true },
        });
        if (!ancestor) break;
        if (ancestor.parentId === categoryId) {
          throw new BadRequestException(
            'Setting this parent would create a circular reference.',
          );
        }
        cursor = ancestor.parentId;
      }
    }
    await this.prisma.category.updateMany({
      where: { id: categoryId, businessId },
      data,
    });
    const result = await this.prisma.category.findFirst({
      where: { id: categoryId, businessId },
    });
    this.auditService.logEvent({
      businessId,
      userId,
      action: 'CATEGORY_UPDATE',
      resourceType: 'Category',
      resourceId: categoryId,
      outcome: 'SUCCESS',
      metadata: data,
      before: before as unknown as Record<string, unknown>,
      after: result as unknown as Record<string, unknown>,
    });
    return result;
  }

  async bulkUpdateCategoryStatus(
    businessId: string,
    userId: string,
    categoryIds: string[],
    status: string,
  ) {
    const result = await this.prisma.category.updateMany({
      where: { id: { in: categoryIds }, businessId },
      data: { status: status as any },
    });
    this.auditService.logEvent({
      businessId,
      userId,
      action: 'CATEGORY_BULK_STATUS',
      resourceType: 'Category',
      resourceId: categoryIds.join(','),
      outcome: 'SUCCESS',
      metadata: { categoryIds, status, updatedCount: result.count },
    });
    return { updated: result.count };
  }

  async listProducts(
    businessId: string,
    query: PaginationQuery & {
      search?: string;
      status?: string;
      categoryId?: string;
      hasVariants?: string;
      hasImages?: string;
      includeTotal?: string;
    },
  ) {
    const pagination = parsePagination(query);
    const search = query.search?.trim();
    const hasVariants = query.hasVariants?.toLowerCase();
    const hasImages = query.hasImages?.toLowerCase();
    const where: Prisma.ProductWhereInput = {
      businessId,
      ...(query.status ? { status: query.status as any } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(search
        ? { name: { contains: search, mode: Prisma.QueryMode.insensitive } }
        : {}),
      ...(hasVariants === 'yes'
        ? { variants: { some: {} } }
        : hasVariants === 'no'
          ? { variants: { none: {} } }
          : {}),
      ...(hasImages === 'yes'
        ? { images: { some: {} } }
        : hasImages === 'no'
          ? { images: { none: {} } }
          : {}),
    };
    const includeTotal =
      query.includeTotal === 'true' || query.includeTotal === '1';
    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: {
          images: true,
          variants: {
            include: { barcodes: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        ...pagination,
      }),
      includeTotal
        ? this.prisma.product.count({ where })
        : Promise.resolve(null),
    ]);
    // Enrich with lastSoldAt per product
    const productIds = items.map((p) => p.id);
    const variantIds = items.flatMap((p) => p.variants.map((v) => v.id));
    let lastSoldMap = new Map<string, Date>();
    if (variantIds.length > 0) {
      const lastSales = await this.prisma.saleLine.groupBy({
        by: ['variantId'],
        where: { variantId: { in: variantIds }, sale: { businessId, status: 'COMPLETED' } },
        _max: { saleId: true },
      });
      if (lastSales.length > 0) {
        const saleIds = lastSales.map((r) => r._max.saleId).filter((id): id is string => Boolean(id));
        const sales = saleIds.length
          ? await this.prisma.sale.findMany({
              where: { id: { in: saleIds } },
              select: { id: true, createdAt: true },
            })
          : [];
        const saleDateMap = new Map(sales.map((s) => [s.id, s.createdAt]));
        // Build variant → date map
        const variantDateMap = new Map<string, Date>();
        for (const row of lastSales) {
          if (row._max.saleId) {
            const date = saleDateMap.get(row._max.saleId);
            if (date) variantDateMap.set(row.variantId, date);
          }
        }
        // Aggregate to product level (latest variant sale date = product last sold)
        for (const product of items) {
          let latest: Date | null = null;
          for (const variant of product.variants) {
            const d = variantDateMap.get(variant.id);
            if (d && (!latest || d > latest)) latest = d;
          }
          if (latest) lastSoldMap.set(product.id, latest);
        }
      }
    }

    const enriched = items.map((item) => ({
      ...item,
      lastSoldAt: lastSoldMap.get(item.id)?.toISOString() ?? null,
    }));

    return buildPaginatedResponse(
      enriched,
      pagination.take,
      typeof total === 'number' ? total : undefined,
    );
  }

  async createProduct(
    businessId: string,
    userId: string,
    data: { name: string; description?: string; categoryId: string },
  ) {
    const category = await this.prisma.category.findFirst({
      where: { id: data.categoryId, businessId },
    });
    if (!category) {
      return null;
    }
    const result = await this.prisma.$transaction(async (tx) => {
      await this.subscriptionService.assertLimit(businessId, 'products', 1, tx);
      return tx.product.create({
        data: {
          businessId,
          name: data.name,
          description: data.description,
          categoryId: data.categoryId,
        },
      });
    });
    this.auditService.logEvent({
      businessId,
      userId,
      action: 'PRODUCT_CREATE',
      resourceType: 'Product',
      resourceId: result.id,
      outcome: 'SUCCESS',
      metadata: data,
    });
    return result;
  }

  async updateProduct(
    businessId: string,
    productId: string,
    userId: string,
    data: {
      name?: string;
      description?: string;
      categoryId?: string;
      status?: string;
    },
  ) {
    const before = await this.prisma.product.findFirst({
      where: { id: productId, businessId },
    });
    if (!before) {
      return null;
    }
    if (before.status === 'ARCHIVED' && data.status && data.status !== 'ARCHIVED') {
      throw new BadRequestException(
        'Archived products cannot be reactivated. Create a new product instead.',
      );
    }
    await this.prisma.product.updateMany({
      where: { id: productId, businessId },
      data: {
        name: data.name,
        description: data.description,
        categoryId: data.categoryId,
        status: data.status as any,
      },
    });
    const result = await this.prisma.product.findFirst({
      where: { id: productId, businessId },
    });
    this.auditService.logEvent({
      businessId,
      userId,
      action: 'PRODUCT_UPDATE',
      resourceType: 'Product',
      resourceId: productId,
      outcome: 'SUCCESS',
      metadata: data,
      before: before as unknown as Record<string, unknown>,
      after: result as unknown as Record<string, unknown>,
    });
    return result;
  }

  async listVariants(
    businessId: string,
    query: PaginationQuery & {
      search?: string;
      status?: string;
      productId?: string;
      branchId?: string;
      hasStockBranchId?: string;
      availability?: string;
      includeTotal?: string;
    },
  ) {
    const pagination = parsePagination(query);

    if (query.branchId) {
      const branch = await this.prisma.branch.findFirst({
        where: { id: query.branchId, businessId },
        select: { id: true },
      });
      if (!branch) {
        throw new BadRequestException('Branch not found.');
      }
    }

    const search = query.search?.trim();
    const availability = query.availability?.toUpperCase();
    const availabilityActive =
      availability === 'ACTIVE'
        ? true
        : availability === 'INACTIVE'
          ? false
          : undefined;
    const availabilityFilter =
      query.branchId || availabilityActive !== undefined
        ? {
            availability: {
              some: {
                ...(query.branchId ? { branchId: query.branchId } : {}),
                ...(availabilityActive !== undefined
                  ? { isActive: availabilityActive }
                  : {}),
              },
            },
          }
        : {};
    const where: Prisma.VariantWhereInput = {
      businessId,
      ...(query.status ? { status: query.status as any } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
      ...availabilityFilter,
      ...(search
        ? {
            OR: [
              {
                name: { contains: search, mode: Prisma.QueryMode.insensitive },
              },
              { sku: { contains: search, mode: Prisma.QueryMode.insensitive } },
              {
                barcodes: {
                  some: {
                    code: {
                      contains: search,
                      mode: Prisma.QueryMode.insensitive,
                    },
                  },
                },
              },
              {
                product: {
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
    const includeTotal =
      query.includeTotal === 'true' || query.includeTotal === '1';
    const [items, total] = await Promise.all([
      this.prisma.variant.findMany({
        where,
        include: {
          barcodes: true,
          availability: true,
          product: { select: { name: true } },
          baseUnit: true,
          sellUnit: true,
        },
        orderBy: { createdAt: 'desc' },
        ...pagination,
      }),
      includeTotal
        ? this.prisma.variant.count({ where })
        : Promise.resolve(null),
    ]);

    // When hasStockBranchId is provided, enrich each variant with hasStock (boolean).
    // This tells the POS whether an item can be sold without exposing raw quantities.
    // Uses a dedicated param so it does NOT interfere with the branchId availability filter.
    let stockMap: Map<string, boolean> | null = null;
    const stockBranchId = query.hasStockBranchId;
    if (stockBranchId && items.length > 0) {
      const snapshots = await this.prisma.stockSnapshot.findMany({
        where: {
          businessId,
          branchId: stockBranchId,
          variantId: { in: items.map((v) => v.id) },
        },
        select: { variantId: true, quantity: true },
      });
      stockMap = new Map(
        snapshots.map((s) => [s.variantId, Number(s.quantity) > 0]),
      );
    }

    // Always enrich with total stock quantity across all branches
    let totalStockMap = new Map<string, number>();
    if (items.length > 0) {
      const allSnapshots = await this.prisma.stockSnapshot.groupBy({
        by: ['variantId'],
        where: {
          businessId,
          variantId: { in: items.map((v) => v.id) },
        },
        _sum: { quantity: true },
      });
      for (const row of allSnapshots) {
        totalStockMap.set(row.variantId, Number(row._sum.quantity ?? 0));
      }
    }

    const enriched = items.map((item) => ({
      ...item,
      totalStock: totalStockMap.get(item.id) ?? 0,
      ...(stockMap !== null
        ? {
            hasStock: stockMap.has(item.id)
              ? stockMap.get(item.id)!
              : item.trackStock
                ? false
                : null,
          }
        : {}),
    }));

    return buildPaginatedResponse(
      enriched,
      pagination.take,
      typeof total === 'number' ? total : undefined,
    );
  }

  async createVariant(
    businessId: string,
    userId: string,
    data: {
      productId: string;
      name: string;
      sku?: string;
      baseUnitId?: string;
      sellUnitId?: string;
      conversionFactor?: number;
      defaultPrice?: number;
      minPrice?: number;
      defaultCost?: number;
      vatMode?: string;
      status?: string;
      trackStock?: boolean;
      imageUrl?: string;
    },
  ) {
    const product = await this.prisma.product.findFirst({
      where: { id: data.productId, businessId },
    });
    if (!product) {
      return null;
    }
    const resolvedBaseUnitId =
      data.baseUnitId ??
      (await this.unitsService.resolveDefaultUnitId(businessId));
    if (data.baseUnitId) {
      await this.unitsService.getUnit(businessId, data.baseUnitId);
    }
    if (data.sellUnitId) {
      await this.unitsService.getUnit(businessId, data.sellUnitId);
    }
    const resolvedSellUnitId = data.sellUnitId ?? resolvedBaseUnitId;
    let conversionFactor = data.conversionFactor ?? 1;
    if (resolvedSellUnitId !== resolvedBaseUnitId) {
      if (!data.conversionFactor || data.conversionFactor <= 0) {
        throw new BadRequestException('Conversion factor is required.');
      }
      conversionFactor = data.conversionFactor;
    } else {
      conversionFactor = 1;
    }
    if (
      data.minPrice !== undefined &&
      data.defaultPrice !== undefined &&
      data.minPrice > data.defaultPrice
    ) {
      throw new BadRequestException(
        'Minimum price cannot be greater than the default price.',
      );
    }
    const result = await this.prisma.variant.create({
      data: {
        businessId,
        productId: data.productId,
        name: data.name,
        sku: data.sku,
        baseUnitId: resolvedBaseUnitId,
        sellUnitId: resolvedSellUnitId,
        conversionFactor,
        defaultPrice: data.defaultPrice,
        minPrice: data.minPrice,
        defaultCost: data.defaultCost,
        vatMode: data.vatMode as any,
        status: data.status as any,
        trackStock: data.trackStock ?? true,
        imageUrl: data.imageUrl,
      },
    });
    this.auditService.logEvent({
      businessId,
      userId,
      action: 'VARIANT_CREATE',
      resourceType: 'Variant',
      resourceId: result.id,
      outcome: 'SUCCESS',
      metadata: data,
    });
    return result;
  }

  async updateVariant(
    businessId: string,
    variantId: string,
    userId: string,
    data: {
      name?: string;
      sku?: string;
      baseUnitId?: string;
      sellUnitId?: string;
      conversionFactor?: number;
      defaultPrice?: number;
      minPrice?: number;
      defaultCost?: number;
      vatMode?: string;
      status?: string;
      trackStock?: boolean;
      imageUrl?: string;
    },
  ) {
    const before = await this.prisma.variant.findFirst({
      where: { id: variantId, businessId },
    });
    if (!before) {
      return null;
    }
    let baseUnitId = data.baseUnitId ?? before.baseUnitId;
    let sellUnitId = data.sellUnitId ?? before.sellUnitId;
    let conversionFactor =
      data.conversionFactor ?? Number(before.conversionFactor ?? 1);

    if (!baseUnitId) {
      baseUnitId = await this.unitsService.resolveDefaultUnitId(businessId);
    }
    if (baseUnitId) {
      await this.unitsService.getUnit(businessId, baseUnitId);
    }
    if (sellUnitId) {
      await this.unitsService.getUnit(businessId, sellUnitId);
    } else {
      sellUnitId = baseUnitId;
    }
    if (sellUnitId !== baseUnitId) {
      if (!conversionFactor || conversionFactor <= 0) {
        throw new BadRequestException('Conversion factor is required.');
      }
    } else {
      conversionFactor = 1;
    }
    const resolvedMinPrice = data.minPrice ?? Number(before.minPrice ?? 0);
    const resolvedDefaultPrice =
      data.defaultPrice ?? Number(before.defaultPrice ?? 0);
    if (resolvedMinPrice > resolvedDefaultPrice) {
      throw new BadRequestException(
        'Minimum price cannot be greater than the default price.',
      );
    }
    await this.prisma.variant.updateMany({
      where: { id: variantId, businessId },
      data: {
        name: data.name,
        sku: data.sku,
        baseUnitId,
        sellUnitId,
        conversionFactor,
        defaultPrice: data.defaultPrice,
        minPrice: data.minPrice,
        defaultCost: data.defaultCost,
        vatMode: data.vatMode as any,
        status: data.status as any,
        trackStock: data.trackStock,
        imageUrl: data.imageUrl,
      },
    });
    const result = await this.prisma.variant.findFirst({
      where: { id: variantId, businessId },
    });
    this.auditService.logEvent({
      businessId,
      userId,
      action: 'VARIANT_UPDATE',
      resourceType: 'Variant',
      resourceId: variantId,
      outcome: 'SUCCESS',
      metadata: data,
      before: before as unknown as Record<string, unknown>,
      after: result as unknown as Record<string, unknown>,
    });
    return result;
  }

  async generateBarcode(businessId: string, userId: string, data: { variantId: string }) {
    const variant = await this.prisma.variant.findFirst({
      where: { id: data.variantId, businessId },
    });
    if (!variant) {
      return null;
    }
    const code = `NV-${randomBytes(8).toString('hex')}`;
    const result = await this.prisma.barcode.create({
      data: {
        businessId,
        variantId: data.variantId,
        code,
      },
    });
    this.auditService.logEvent({
      businessId,
      userId,
      action: 'BARCODE_GENERATE',
      resourceType: 'Barcode',
      resourceId: result.id,
      outcome: 'SUCCESS',
      metadata: { variantId: data.variantId, code },
    });
    return result;
  }

  async lookupBarcode(businessId: string, code: string) {
    const matches = await this.prisma.barcode.findMany({
      where: { businessId, code, isActive: true },
      include: {
        variant: {
          include: { product: true },
        },
      },
    });
    if (matches.length === 0) {
      return null;
    }
    if (matches.length > 1) {
      throw new BadRequestException('Multiple variants matched this barcode.');
    }
    return matches[0];
  }

  async createBarcode(
    businessId: string,
    userId: string,
    data: { variantId: string; code: string },
  ) {
    const variant = await this.prisma.variant.findFirst({
      where: { id: data.variantId, businessId },
    });
    if (!variant) {
      return null;
    }
    const existing = await this.prisma.barcode.findFirst({
      where: { businessId, code: data.code },
    });
    if (existing) {
      throw new BadRequestException(
        'Barcode is already assigned to another variant.',
      );
    }
    const result = await this.prisma.barcode.create({
      data: {
        businessId,
        variantId: data.variantId,
        code: data.code,
      },
    });
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'BARCODE_CREATE',
      resourceType: 'Barcode',
      resourceId: result.id,
      outcome: 'SUCCESS',
      metadata: data,
    });
    return result;
  }

  async reassignBarcode(
    businessId: string,
    userId: string,
    roleIds: string[],
    data: { barcodeId: string; newVariantId: string; reason?: string },
  ) {
    if (!data.reason?.trim()) {
      throw new BadRequestException(
        'Reason is required for barcode reassignment.',
      );
    }
    const barcode = await this.prisma.barcode.findFirst({
      where: { id: data.barcodeId, businessId },
    });
    if (!barcode) {
      return null;
    }
    const targetVariant = await this.prisma.variant.findFirst({
      where: { id: data.newVariantId, businessId },
    });
    if (!targetVariant) {
      return null;
    }

    const approval = await this.approvalsService.requestApproval({
      businessId,
      actionType: 'BARCODE_REASSIGN',
      requestedByUserId: userId,
      requesterRoleIds: roleIds,
      reason: data.reason,
      metadata: data,
      targetType: 'Barcode',
      targetId: barcode.id,
    });

    if (approval.required) {
      return { approvalRequired: true, approvalId: approval.approval?.id };
    }

    const replacement = await this.prisma.$transaction(async (tx) => {
      await tx.barcode.updateMany({
        where: { id: barcode.id, businessId },
        data: { isActive: false },
      });
      return tx.barcode.create({
        data: {
          businessId,
          variantId: data.newVariantId,
          code: barcode.code,
          isActive: true,
        },
      });
    });

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'BARCODE_REASSIGN',
      resourceType: 'Barcode',
      resourceId: replacement.id,
      outcome: 'SUCCESS',
      metadata: data,
    });

    return replacement;
  }

  async reassignSku(
    businessId: string,
    userId: string,
    roleIds: string[],
    data: { variantId: string; sku: string; reason?: string },
  ) {
    if (!data.reason?.trim()) {
      throw new BadRequestException('Reason is required for SKU reassignment.');
    }
    const variant = await this.prisma.variant.findFirst({
      where: { id: data.variantId, businessId },
    });
    if (!variant) {
      return null;
    }

    const approval = await this.approvalsService.requestApproval({
      businessId,
      actionType: 'SKU_REASSIGN',
      requestedByUserId: userId,
      requesterRoleIds: roleIds,
      reason: data.reason,
      metadata: data,
      targetType: 'Variant',
      targetId: data.variantId,
    });

    if (approval.required) {
      return { approvalRequired: true, approvalId: approval.approval?.id };
    }

    await this.prisma.variant.updateMany({
      where: { id: data.variantId, businessId },
      data: { sku: data.sku },
    });
    const updated = await this.prisma.variant.findFirst({
      where: { id: data.variantId, businessId },
    });

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'SKU_REASSIGN',
      resourceType: 'Variant',
      resourceId: data.variantId,
      outcome: 'SUCCESS',
      metadata: data,
    });

    return updated;
  }

  async updateVariantAvailability(
    businessId: string,
    userId: string,
    data: { variantId: string; branchId: string; isActive: boolean },
  ) {
    const [variant, branch] = await Promise.all([
      this.prisma.variant.findFirst({
        where: { id: data.variantId, businessId },
      }),
      this.prisma.branch.findFirst({
        where: { id: data.branchId, businessId },
      }),
    ]);
    if (!variant || !branch) {
      return null;
    }

    const availability = await this.prisma.branchVariantAvailability.upsert({
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
        isActive: data.isActive,
      },
      update: { isActive: data.isActive },
    });

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'VARIANT_AVAILABILITY_UPDATE',
      resourceType: 'Variant',
      resourceId: data.variantId,
      outcome: 'SUCCESS',
      metadata: data,
    });

    return availability;
  }

  async createPresignedProductImageUpload(
    businessId: string,
    data: { productId: string; filename: string; contentType?: string },
  ) {
    const product = await this.prisma.product.findFirst({
      where: { id: data.productId, businessId },
    });
    if (!product) {
      return null;
    }
    const key = this.storageService.buildObjectKey(
      `products/${product.id}/${Date.now()}-${data.filename}`,
    );
    return this.storageService.createPresignedUpload({
      key,
      contentType: data.contentType,
    });
  }

  async registerProductImage(
    businessId: string,
    userId: string,
    data: {
      productId: string;
      url: string;
      filename: string;
      mimeType?: string;
      sizeMb?: number;
      isPrimary?: boolean;
    },
  ) {
    const product = await this.prisma.product.findFirst({
      where: { id: data.productId, businessId },
    });
    if (!product) {
      return null;
    }

    const subscription =
      await this.subscriptionService.getSubscription(businessId);
    const allowExtra = subscription?.tier !== SubscriptionTier.STARTER;

    const existingPrimary = await this.prisma.productImage.findFirst({
      where: {
        businessId,
        productId: data.productId,
        isPrimary: true,
        status: 'ACTIVE',
      },
    });

    if (!existingPrimary && !data.isPrimary) {
      throw new BadRequestException('Primary image is required.');
    }

    if (existingPrimary && !allowExtra && !data.isPrimary) {
      throw new BadRequestException(
        'Additional images are not enabled for this subscription.',
      );
    }

    if (data.sizeMb && data.sizeMb > 20) {
      throw new BadRequestException('Image exceeds 20MB limit.');
    }

    if (data.sizeMb) {
      await this.subscriptionService.assertLimit(
        businessId,
        'storageGb',
        data.sizeMb,
      );
    }

    const image = await this.prisma.$transaction(async (tx) => {
      if (data.isPrimary) {
        await tx.productImage.updateMany({
          where: {
            businessId,
            productId: data.productId,
            isPrimary: true,
          },
          data: { isPrimary: false },
        });
      }
      return tx.productImage.create({
        data: {
          businessId,
          productId: data.productId,
          url: data.url,
          filename: data.filename,
          mimeType: data.mimeType,
          sizeMb: data.sizeMb ? new Prisma.Decimal(data.sizeMb) : null,
          isPrimary: data.isPrimary ?? false,
        },
      });
    });

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'PRODUCT_IMAGE_ADD',
      resourceType: 'ProductImage',
      resourceId: image.id,
      outcome: 'SUCCESS',
      metadata: data,
    });

    return image;
  }

  async setPrimaryProductImage(
    businessId: string,
    productId: string,
    imageId: string,
    userId: string,
  ) {
    const image = await this.prisma.productImage.findFirst({
      where: { id: imageId, businessId, productId },
    });
    if (!image) {
      return null;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.productImage.updateMany({
        where: { businessId, productId, isPrimary: true },
        data: { isPrimary: false },
      });
      await tx.productImage.updateMany({
        where: { id: imageId, businessId },
        data: { isPrimary: true },
      });
    });
    const updated = await this.prisma.productImage.findFirst({
      where: { id: imageId, businessId },
    });

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'PRODUCT_IMAGE_PRIMARY',
      resourceType: 'ProductImage',
      resourceId: imageId,
      outcome: 'SUCCESS',
    });

    return updated;
  }

  async removeProductImage(
    businessId: string,
    productId: string,
    imageId: string,
    userId: string,
  ) {
    const image = await this.prisma.productImage.findFirst({
      where: { id: imageId, businessId, productId },
    });
    if (!image) {
      return null;
    }

    await this.prisma.productImage.updateMany({
      where: { id: imageId, businessId },
      data: { status: 'REMOVED' },
    });
    const updated = await this.prisma.productImage.findFirst({
      where: { id: imageId, businessId },
    });

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'PRODUCT_IMAGE_REMOVE',
      resourceType: 'ProductImage',
      resourceId: imageId,
      outcome: 'SUCCESS',
    });

    return updated;
  }

  async buildBarcodeLabels(businessId: string, data: { variantIds: string[] }) {
    const variants = await this.prisma.variant.findMany({
      where: { businessId, id: { in: data.variantIds } },
      include: { product: true, barcodes: { where: { isActive: true } } },
    });

    return variants.map((variant) => ({
      variantId: variant.id,
      productName: variant.product.name,
      variantName: variant.name,
      sku: variant.sku,
      barcode: variant.barcodes[0]?.code ?? null,
      price: variant.defaultPrice ? Number(variant.defaultPrice) : null,
    }));
  }

  async createPresignedVariantImageUpload(
    businessId: string,
    data: { variantId: string; filename: string; contentType?: string },
  ) {
    const variant = await this.prisma.variant.findFirst({
      where: { id: data.variantId, businessId },
    });
    if (!variant) {
      return null;
    }
    const key = this.storageService.buildObjectKey(
      `variants/${variant.id}/${Date.now()}-${data.filename}`,
    );
    return this.storageService.createPresignedUpload({
      key,
      contentType: data.contentType,
    });
  }

  async setVariantImage(
    businessId: string,
    userId: string,
    data: { variantId: string; imageUrl: string },
  ) {
    const variant = await this.prisma.variant.findFirst({
      where: { id: data.variantId, businessId },
    });
    if (!variant) {
      return null;
    }
    await this.prisma.variant.updateMany({
      where: { id: data.variantId, businessId },
      data: { imageUrl: data.imageUrl },
    });
    const updated = await this.prisma.variant.findFirst({
      where: { id: data.variantId, businessId },
    });
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'VARIANT_IMAGE_UPDATE',
      resourceType: 'Variant',
      resourceId: data.variantId,
      outcome: 'SUCCESS',
      metadata: data,
    });
    return updated;
  }
}
