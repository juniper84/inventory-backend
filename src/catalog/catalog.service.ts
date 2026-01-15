import { BadRequestException, Injectable } from '@nestjs/common';
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
        ...(search ? { name: { contains: search, mode: Prisma.QueryMode.insensitive } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      ...pagination,
    });
    return buildPaginatedResponse(items, pagination.take);
  }

  async createCategory(
    businessId: string,
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
      userId: 'system',
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
    data: { name?: string; parentId?: string },
  ) {
    const before = await this.prisma.category.findFirst({
      where: { id: categoryId, businessId },
    });
    if (!before) {
      return null;
    }
    const result = await this.prisma.category.update({
      where: { id: categoryId },
      data,
    });
    this.auditService.logEvent({
      businessId,
      userId: 'system',
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
      ...(search ? { name: { contains: search, mode: Prisma.QueryMode.insensitive } } : {}),
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
    return buildPaginatedResponse(
      items,
      pagination.take,
      typeof total === 'number' ? total : undefined,
    );
  }

  async createProduct(
    businessId: string,
    data: { name: string; description?: string; categoryId?: string },
  ) {
    if (data.categoryId) {
      const category = await this.prisma.category.findFirst({
        where: { id: data.categoryId, businessId },
      });
      if (!category) {
        return null;
      }
    }
    await this.subscriptionService.assertLimit(businessId, 'products');
    const result = await this.prisma.product.create({
      data: {
        businessId,
        name: data.name,
        description: data.description,
        categoryId: data.categoryId,
      },
    });
    this.auditService.logEvent({
      businessId,
      userId: 'system',
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
    const result = await this.prisma.product.update({
      where: { id: productId },
      data: {
        name: data.name,
        description: data.description,
        categoryId: data.categoryId,
        status: data.status as any,
      },
    });
    this.auditService.logEvent({
      businessId,
      userId: 'system',
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
      availability?: string;
      includeTotal?: string;
    },
  ) {
    const pagination = parsePagination(query);
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
              { name: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { sku: { contains: search, mode: Prisma.QueryMode.insensitive } },
              {
                barcodes: {
                  some: { code: { contains: search, mode: Prisma.QueryMode.insensitive } },
                },
              },
              { product: { name: { contains: search, mode: Prisma.QueryMode.insensitive } } },
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
    return buildPaginatedResponse(
      items,
      pagination.take,
      typeof total === 'number' ? total : undefined,
    );
  }

  async createVariant(
    businessId: string,
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
      userId: 'system',
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
    const result = await this.prisma.variant.update({
      where: { id: variantId },
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
    this.auditService.logEvent({
      businessId,
      userId: 'system',
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

  async generateBarcode(businessId: string, data: { variantId: string }) {
    const variant = await this.prisma.variant.findFirst({
      where: { id: data.variantId, businessId },
    });
    if (!variant) {
      return null;
    }
    const code = `NV-${Date.now()}`;
    const result = await this.prisma.barcode.create({
      data: {
        businessId,
        variantId: data.variantId,
        code,
      },
    });
    this.auditService.logEvent({
      businessId,
      userId: 'system',
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
    data: { variantId: string; code: string },
  ) {
    const variant = await this.prisma.variant.findFirst({
      where: { id: data.variantId, businessId },
    });
    if (!variant) {
      return null;
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
      userId: 'system',
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

    await this.prisma.barcode.update({
      where: { id: barcode.id },
      data: { isActive: false },
    });

    const replacement = await this.prisma.barcode.create({
      data: {
        businessId,
        variantId: data.newVariantId,
        code: barcode.code,
        isActive: true,
      },
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

    const updated = await this.prisma.variant.update({
      where: { id: data.variantId },
      data: { sku: data.sku },
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
      userId: 'system',
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

    if (data.isPrimary) {
      await this.prisma.productImage.updateMany({
        where: {
          businessId,
          productId: data.productId,
          isPrimary: true,
        },
        data: { isPrimary: false },
      });
    }

    const image = await this.prisma.productImage.create({
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
  ) {
    const image = await this.prisma.productImage.findFirst({
      where: { id: imageId, businessId, productId },
    });
    if (!image) {
      return null;
    }

    await this.prisma.productImage.updateMany({
      where: { businessId, productId, isPrimary: true },
      data: { isPrimary: false },
    });

    const updated = await this.prisma.productImage.update({
      where: { id: imageId },
      data: { isPrimary: true },
    });

    await this.auditService.logEvent({
      businessId,
      userId: 'system',
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
  ) {
    const image = await this.prisma.productImage.findFirst({
      where: { id: imageId, businessId, productId },
    });
    if (!image) {
      return null;
    }

    const updated = await this.prisma.productImage.update({
      where: { id: imageId },
      data: { status: 'REMOVED' },
    });

    await this.auditService.logEvent({
      businessId,
      userId: 'system',
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
    const updated = await this.prisma.variant.update({
      where: { id: data.variantId },
      data: { imageUrl: data.imageUrl },
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
