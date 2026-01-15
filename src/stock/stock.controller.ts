import {
  Body,
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { StockService } from './stock.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { LossReason, StockMovementType } from '@prisma/client';

@Controller('stock')
export class StockController {
  constructor(private readonly stockService: StockService) {}

  @Get()
  @Permissions(PermissionsList.STOCK_READ)
  listStock(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      branchId?: string;
      variantId?: string;
      search?: string;
      status?: string;
      categoryId?: string;
      includeTotal?: string;
    },
  ) {
    return this.stockService.listStock(
      req.user?.businessId || '',
      query,
      req.user?.branchScope ?? [],
    );
  }

  @Get('movements')
  @Permissions(PermissionsList.STOCK_READ)
  listMovements(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      branchId?: string;
      variantId?: string;
      type?: string;
      actorId?: string;
      search?: string;
      reason?: string;
      from?: string;
      to?: string;
    },
  ) {
    const typedQuery = {
      ...query,
      type: query.type as StockMovementType | undefined,
    };
    return this.stockService.listMovements(
      req.user?.businessId || '',
      typedQuery,
      req.user?.branchScope ?? [],
    );
  }

  @Get('batches')
  @Permissions(PermissionsList.STOCK_READ)
  listBatches(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      branchId?: string;
      variantId?: string;
      search?: string;
    },
  ) {
    return this.stockService.listBatches(
      req.user?.businessId || '',
      query,
      req.user?.branchScope ?? [],
    );
  }

  @Post('adjustments')
  @Permissions(PermissionsList.STOCK_WRITE)
  createAdjustment(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; roleIds?: string[] };
      headers?: Record<string, string | string[] | undefined>;
    },
    @Body()
    body: {
      branchId: string;
      variantId: string;
      quantity: number;
      unitId?: string;
      reason?: string;
      type: 'POSITIVE' | 'NEGATIVE';
      batchId?: string;
      lossReason?: LossReason;
      idempotencyKey?: string;
    },
  ) {
    const offlineHeader =
      req.headers?.['x-offline-mode'] ?? req.headers?.['x-offline'];
    if (offlineHeader === 'true' || offlineHeader === '1') {
      return {
        offlineDraft: true,
        message: 'Queue stock adjustments offline and sync later.',
      };
    }
    if (!body.variantId) {
      throw new BadRequestException('variantId is required.');
    }
    return this.stockService.createAdjustment(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      req.user?.roleIds || [],
      body,
    );
  }

  @Post('counts')
  @Permissions(PermissionsList.STOCK_WRITE)
  createStockCount(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; roleIds?: string[] };
      headers?: Record<string, string | string[] | undefined>;
    },
    @Body()
    body: {
      branchId: string;
      variantId: string;
      countedQuantity: number;
      unitId?: string;
      reason?: string;
      batchId?: string;
      idempotencyKey?: string;
    },
  ) {
    const offlineHeader =
      req.headers?.['x-offline-mode'] ?? req.headers?.['x-offline'];
    if (offlineHeader === 'true' || offlineHeader === '1') {
      throw new ForbiddenException(
        'Stock counts are not allowed in offline mode.',
      );
    }
    if (
      body.countedQuantity === undefined ||
      body.countedQuantity === null ||
      Number.isNaN(Number(body.countedQuantity))
    ) {
      throw new BadRequestException('countedQuantity is required.');
    }
    return this.stockService.createStockCount(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      req.user?.roleIds || [],
      body,
    );
  }

  @Post('batches')
  @Permissions(PermissionsList.STOCK_WRITE)
  createBatch(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: {
      branchId: string;
      variantId: string;
      code: string;
      expiryDate?: string;
    },
  ) {
    return this.stockService.createBatch(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      body,
    );
  }

  @Get('reorder-points')
  @Permissions(PermissionsList.STOCK_READ)
  listReorderPoints(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      branchId?: string;
      variantId?: string;
    },
  ) {
    return this.stockService.listReorderPoints(
      req.user?.businessId || '',
      query,
      req.user?.branchScope ?? [],
    );
  }

  @Post('reorder-points')
  @Permissions(PermissionsList.STOCK_WRITE)
  upsertReorderPoint(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: {
      branchId: string;
      variantId: string;
      minQuantity: number;
      reorderQuantity: number;
    },
  ) {
    if (
      body.minQuantity === undefined ||
      body.minQuantity === null ||
      Number.isNaN(Number(body.minQuantity)) ||
      body.reorderQuantity === undefined ||
      body.reorderQuantity === null ||
      Number.isNaN(Number(body.reorderQuantity))
    ) {
      throw new BadRequestException(
        'minQuantity and reorderQuantity are required.',
      );
    }
    return this.stockService.upsertReorderPoint(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      body,
    );
  }

  @Get('reorder-suggestions')
  @Permissions(PermissionsList.STOCK_READ)
  listReorderSuggestions(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Query() query: { branchId?: string },
  ) {
    return this.stockService.listReorderSuggestions(
      req.user?.businessId || '',
      query,
      req.user?.branchScope ?? [],
    );
  }
}
