import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { PurchasesService } from './purchases.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';

@Controller()
export class PurchasesController {
  constructor(private readonly purchasesService: PurchasesService) {}

  @Post('purchases')
  @Permissions(PermissionsList.PURCHASES_WRITE)
  createPurchase(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; roleIds?: string[] };
      headers?: Record<string, string | string[] | undefined>;
    },
    @Body()
    body: {
      branchId: string;
      supplierId: string;
      lines: {
        variantId: string;
        quantity: number;
        unitCost: number;
        unitId?: string;
      }[];
      expectedAt?: string;
      idempotencyKey?: string;
    },
  ) {
    const offlineHeader =
      req.headers?.['x-offline-mode'] ?? req.headers?.['x-offline'];
    if (offlineHeader === 'true' || offlineHeader === '1') {
      return {
        offlineDraft: true,
        message: 'Queue purchase drafts offline and sync later.',
      };
    }
    return this.purchasesService.createPurchase(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      req.user?.roleIds || [],
      body,
    );
  }

  @Post('purchase-orders')
  @Permissions(PermissionsList.PURCHASES_WRITE)
  createPurchaseOrder(
    @Req()
    req: {
      user?: { businessId: string; sub?: string };
      headers?: Record<string, string | string[] | undefined>;
    },
    @Body()
    body: {
      branchId: string;
      supplierId: string;
      lines: {
        variantId: string;
        quantity: number;
        unitCost: number;
        unitId?: string;
      }[];
      idempotencyKey?: string;
    },
  ) {
    const offlineHeader =
      req.headers?.['x-offline-mode'] ?? req.headers?.['x-offline'];
    if (offlineHeader === 'true' || offlineHeader === '1') {
      return {
        offlineDraft: true,
        message: 'Queue purchase orders offline and sync later.',
      };
    }
    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      throw new BadRequestException('lines are required.');
    }
    return this.purchasesService.createPurchaseOrder(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      body,
    );
  }

  @Put('purchase-orders/:id')
  @Permissions(PermissionsList.PURCHASES_WRITE)
  updatePurchaseOrder(
    @Param('id') id: string,
    @Req()
    req: { user?: { businessId: string; sub?: string; roleIds?: string[] } },
    @Body()
    body: {
      lines: {
        variantId: string;
        quantity: number;
        unitCost: number;
        unitId?: string;
      }[];
      expectedAt?: string | null;
    },
  ) {
    return this.purchasesService.updatePurchaseOrder(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      req.user?.roleIds || [],
      id,
      body,
    );
  }

  @Post('purchase-orders/:id/approve')
  @Permissions(PermissionsList.PURCHASES_WRITE)
  approvePurchaseOrder(
    @Param('id') id: string,
    @Req()
    req: { user?: { businessId: string; sub?: string; roleIds?: string[] } },
  ) {
    return this.purchasesService.approvePurchaseOrder(
      req.user?.businessId || '',
      id,
      req.user?.sub || 'system',
      req.user?.roleIds || [],
    );
  }

  @Post('receiving')
  @Permissions(PermissionsList.PURCHASES_WRITE)
  receive(
    @Req()
    req: {
      user?: { businessId: string; sub?: string };
      headers?: Record<string, string | string[] | undefined>;
    },
    @Body()
    body: {
      purchaseId?: string;
      purchaseOrderId?: string;
      lines: {
        variantId: string;
        quantity: number;
        unitCost: number;
        unitId?: string;
        batchId?: string;
        batchCode?: string;
        expiryDate?: string;
      }[];
      overrideReason?: string;
      idempotencyKey?: string;
    },
  ) {
    const offlineHeader =
      req.headers?.['x-offline-mode'] ?? req.headers?.['x-offline'];
    if (offlineHeader === 'true' || offlineHeader === '1') {
      throw new ForbiddenException('Receiving is not allowed in offline mode.');
    }
    if (!body.purchaseId && !body.purchaseOrderId) {
      throw new BadRequestException(
        'purchaseId or purchaseOrderId is required.',
      );
    }
    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      throw new BadRequestException('lines are required.');
    }
    return this.purchasesService.receive(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      body,
    );
  }

  @Get('purchases')
  @Permissions(PermissionsList.PURCHASES_READ)
  listPurchases(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      search?: string;
      status?: string;
      supplierId?: string;
      branchId?: string;
      from?: string;
      to?: string;
      includeTotal?: string;
    },
  ) {
    return this.purchasesService.listPurchases(
      req.user?.businessId || '',
      query,
      req.user?.branchScope ?? [],
    );
  }

  @Get('purchase-orders')
  @Permissions(PermissionsList.PURCHASES_READ)
  listPurchaseOrders(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      search?: string;
      status?: string;
      supplierId?: string;
      branchId?: string;
      from?: string;
      to?: string;
      includeTotal?: string;
    },
  ) {
    return this.purchasesService.listPurchaseOrders(
      req.user?.businessId || '',
      query,
      req.user?.branchScope ?? [],
    );
  }

  @Get('receiving')
  @Permissions(PermissionsList.PURCHASES_READ)
  listReceiving(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      search?: string;
      branchId?: string;
      variantId?: string;
      purchaseId?: string;
      purchaseOrderId?: string;
      status?: string;
      from?: string;
      to?: string;
      includeTotal?: string;
    },
  ) {
    return this.purchasesService.listReceivings(
      req.user?.businessId || '',
      query,
      req.user?.branchScope ?? [],
    );
  }

  @Get('supplier-returns')
  @Permissions(PermissionsList.PURCHASES_READ)
  listSupplierReturns(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      search?: string;
      status?: string;
      supplierId?: string;
      branchId?: string;
      from?: string;
      to?: string;
    },
  ) {
    return this.purchasesService.listSupplierReturns(
      req.user?.businessId || '',
      query,
      req.user?.branchScope ?? [],
    );
  }

  @Post('purchases/:id/payments')
  @Permissions(PermissionsList.PURCHASES_WRITE)
  recordPayment(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: {
      method: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER' | 'OTHER';
      amount: number;
      reference?: string;
      methodLabel?: string;
    },
  ) {
    return this.purchasesService.recordPayment(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      {
        purchaseId: id,
        ...body,
      },
    );
  }

  @Post('supplier-returns')
  @Permissions(PermissionsList.PURCHASES_WRITE)
  supplierReturn(
    @Req()
    req: { user?: { businessId: string; sub?: string; roleIds?: string[] } },
    @Body()
    body: {
      branchId: string;
      supplierId: string;
      purchaseId?: string;
      purchaseOrderId?: string;
      reason?: string;
      lines: {
        variantId: string;
        quantity: number;
        unitCost: number;
        unitId?: string;
        receivingLineId?: string;
      }[];
    },
  ) {
    return this.purchasesService.createSupplierReturn(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      req.user?.roleIds || [],
      body,
    );
  }
}
