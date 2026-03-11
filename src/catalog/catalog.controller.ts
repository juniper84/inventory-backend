import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { requireBusinessId, requireUserId } from '../common/request-context';

@Controller()
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get('categories')
  @Permissions(PermissionsList.CATALOG_READ)
  listCategories(
    @Req() req: { user?: { businessId: string } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      search?: string;
      status?: string;
    },
  ) {
    return this.catalogService.listCategories(
      requireBusinessId(req),
      query,
    );
  }

  @Post('categories')
  @Permissions(PermissionsList.CATALOG_WRITE)
  createCategory(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { name: string; parentId?: string },
  ) {
    if (!body.name?.trim()) {
      throw new BadRequestException('name is required.');
    }
    return this.catalogService.createCategory(requireBusinessId(req), requireUserId(req), body);
  }

  @Put('categories/:id')
  @Permissions(PermissionsList.CATALOG_WRITE)
  updateCategory(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { name?: string; parentId?: string },
  ) {
    return this.catalogService.updateCategory(
      requireBusinessId(req),
      id,
      requireUserId(req),
      body,
    );
  }

  @Get('products')
  @Permissions(PermissionsList.CATALOG_READ)
  listProducts(
    @Req() req: { user?: { businessId: string } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      search?: string;
      status?: string;
      categoryId?: string;
      hasVariants?: string;
      hasImages?: string;
      includeTotal?: string;
    },
  ) {
    return this.catalogService.listProducts(requireBusinessId(req), query);
  }

  @Post('products')
  @Permissions(PermissionsList.CATALOG_WRITE)
  createProduct(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { name: string; description?: string; categoryId: string },
  ) {
    if (!body.categoryId) {
      throw new BadRequestException('categoryId is required.');
    }
    return this.catalogService.createProduct(requireBusinessId(req), requireUserId(req), body);
  }

  @Put('products/:id')
  @Permissions(PermissionsList.CATALOG_WRITE)
  updateProduct(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: {
      name?: string;
      description?: string;
      categoryId?: string;
      status?: string;
    },
  ) {
    return this.catalogService.updateProduct(
      requireBusinessId(req),
      id,
      requireUserId(req),
      body,
    );
  }

  @Get('variants')
  @Permissions(PermissionsList.CATALOG_READ)
  listVariants(
    @Req() req: { user?: { businessId: string } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      search?: string;
      status?: string;
      productId?: string;
      branchId?: string;
      hasStockBranchId?: string;
      availability?: string;
      includeTotal?: string;
    },
  ) {
    return this.catalogService.listVariants(requireBusinessId(req), query);
  }

  @Post('variants')
  @Permissions(PermissionsList.CATALOG_WRITE)
  createVariant(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: {
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
    if (!body.baseUnitId || !body.sellUnitId) {
      throw new BadRequestException('baseUnitId and sellUnitId are required.');
    }
    return this.catalogService.createVariant(requireBusinessId(req), requireUserId(req), body);
  }

  @Put('variants/:id')
  @Permissions(PermissionsList.CATALOG_WRITE)
  updateVariant(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: {
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
    return this.catalogService.updateVariant(
      requireBusinessId(req),
      id,
      requireUserId(req),
      body,
    );
  }

  @Get('barcodes/lookup')
  @Permissions(PermissionsList.CATALOG_READ)
  lookupBarcode(
    @Req() req: { user?: { businessId: string } },
    @Query('code') code: string,
  ) {
    return this.catalogService.lookupBarcode(requireBusinessId(req), code);
  }

  @Post('barcodes')
  @Permissions(PermissionsList.CATALOG_WRITE)
  createBarcode(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { variantId: string; code: string },
  ) {
    return this.catalogService.createBarcode(requireBusinessId(req), requireUserId(req), body);
  }

  @Post('barcodes/generate')
  @Permissions(PermissionsList.CATALOG_WRITE)
  generateBarcode(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { variantId: string },
  ) {
    return this.catalogService.generateBarcode(
      requireBusinessId(req),
      requireUserId(req),
      body,
    );
  }

  @Post('barcodes/:id/reassign')
  @Permissions(PermissionsList.CATALOG_WRITE)
  reassignBarcode(
    @Param('id') id: string,
    @Req()
    req: { user?: { businessId: string; sub?: string; roleIds?: string[] } },
    @Body() body: { newVariantId: string; reason?: string },
  ) {
    return this.catalogService.reassignBarcode(
      requireBusinessId(req),
      requireUserId(req),
      req.user?.roleIds || [],
      { barcodeId: id, newVariantId: body.newVariantId, reason: body.reason },
    );
  }

  @Post('variants/:id/sku')
  @Permissions(PermissionsList.CATALOG_WRITE)
  reassignSku(
    @Param('id') id: string,
    @Req()
    req: { user?: { businessId: string; sub?: string; roleIds?: string[] } },
    @Body() body: { sku: string; reason?: string },
  ) {
    return this.catalogService.reassignSku(
      requireBusinessId(req),
      requireUserId(req),
      req.user?.roleIds || [],
      { variantId: id, sku: body.sku, reason: body.reason },
    );
  }

  @Post('variants/:id/availability')
  @Permissions(PermissionsList.CATALOG_WRITE)
  updateAvailability(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { branchId: string; isActive: boolean },
  ) {
    return this.catalogService.updateVariantAvailability(
      requireBusinessId(req),
      requireUserId(req),
      { variantId: id, branchId: body.branchId, isActive: body.isActive },
    );
  }

  @Post('products/:id/images/presign')
  @Permissions(PermissionsList.CATALOG_WRITE)
  presignProductImage(
    @Param('id') id: string,
    @Req()
    req: {
      user?: { businessId: string };
      headers?: Record<string, string | string[] | undefined>;
    },
    @Body() body: { filename: string; contentType?: string },
  ) {
    const offlineHeader = req.headers?.['x-offline-mode'];
    if (offlineHeader === 'true' || offlineHeader === '1') {
      return null;
    }
    return this.catalogService.createPresignedProductImageUpload(
      requireBusinessId(req),
      { productId: id, filename: body.filename, contentType: body.contentType },
    );
  }

  @Post('products/:id/images')
  @Permissions(PermissionsList.CATALOG_WRITE)
  registerProductImage(
    @Param('id') id: string,
    @Req()
    req: {
      user?: { businessId: string; sub?: string };
      headers?: Record<string, string | string[] | undefined>;
    },
    @Body()
    body: {
      url: string;
      filename: string;
      mimeType?: string;
      sizeMb?: number;
      isPrimary?: boolean;
    },
  ) {
    const offlineHeader = req.headers?.['x-offline-mode'];
    if (offlineHeader === 'true' || offlineHeader === '1') {
      return null;
    }
    return this.catalogService.registerProductImage(
      requireBusinessId(req),
      requireUserId(req),
      { productId: id, ...body },
    );
  }

  @Post('products/:id/images/:imageId/primary')
  @Permissions(PermissionsList.CATALOG_WRITE)
  setPrimaryImage(
    @Param('id') id: string,
    @Param('imageId') imageId: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
  ) {
    return this.catalogService.setPrimaryProductImage(
      requireBusinessId(req),
      id,
      imageId,
      requireUserId(req),
    );
  }

  @Post('products/:id/images/:imageId/remove')
  @Permissions(PermissionsList.CATALOG_WRITE)
  removeProductImage(
    @Param('id') id: string,
    @Param('imageId') imageId: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
  ) {
    return this.catalogService.removeProductImage(
      requireBusinessId(req),
      id,
      imageId,
      requireUserId(req),
    );
  }

  @Post('barcodes/labels')
  @Permissions(PermissionsList.CATALOG_READ)
  buildLabels(
    @Req() req: { user?: { businessId: string } },
    @Body() body: { variantIds: string[] },
  ) {
    return this.catalogService.buildBarcodeLabels(
      requireBusinessId(req),
      body,
    );
  }

  @Post('variants/:id/image/presign')
  @Permissions(PermissionsList.CATALOG_WRITE)
  presignVariantImage(
    @Param('id') id: string,
    @Req()
    req: {
      user?: { businessId: string };
      headers?: Record<string, string | string[] | undefined>;
    },
    @Body() body: { filename: string; contentType?: string },
  ) {
    const offlineHeader = req.headers?.['x-offline-mode'];
    if (offlineHeader === 'true' || offlineHeader === '1') {
      return null;
    }
    return this.catalogService.createPresignedVariantImageUpload(
      requireBusinessId(req),
      { variantId: id, filename: body.filename, contentType: body.contentType },
    );
  }

  @Post('variants/:id/image')
  @Permissions(PermissionsList.CATALOG_WRITE)
  setVariantImage(
    @Param('id') id: string,
    @Req()
    req: {
      user?: { businessId: string; sub?: string };
      headers?: Record<string, string | string[] | undefined>;
    },
    @Body() body: { imageUrl: string },
  ) {
    const offlineHeader = req.headers?.['x-offline-mode'];
    if (offlineHeader === 'true' || offlineHeader === '1') {
      return null;
    }
    return this.catalogService.setVariantImage(
      requireBusinessId(req),
      requireUserId(req),
      { variantId: id, imageUrl: body.imageUrl },
    );
  }
}
