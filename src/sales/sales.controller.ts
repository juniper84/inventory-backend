import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { SalesService } from './sales.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';

@Controller('sales')
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  @Post('draft')
  @Permissions(PermissionsList.SALES_WRITE)
  createDraft(
    @Req()
    req: {
      user?: {
        businessId: string;
        sub?: string;
        roleIds?: string[];
        permissions?: string[];
      };
    },
    @Body()
    body: {
      branchId: string;
      cashierId?: string;
      customerId?: string;
      cartDiscount?: number;
      isOffline?: boolean;
      offlineDeviceId?: string;
      lines: {
        variantId: string;
        quantity: number;
        unitId?: string;
        unitPrice?: number;
        vatMode?: 'INCLUSIVE' | 'EXCLUSIVE' | 'EXEMPT';
        vatRate?: number;
        lineDiscount?: number;
        barcode?: string;
        batchId?: string;
      }[];
    },
  ) {
    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      throw new BadRequestException('lines are required.');
    }
    return this.salesService.createDraft(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      req.user?.roleIds || [],
      req.user?.permissions || [],
      body,
    );
  }

  @Post('complete')
  @Permissions(PermissionsList.SALES_WRITE)
  complete(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; permissions?: string[] };
    },
    @Body()
    body: {
      saleId: string;
      payments: {
        method: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER' | 'OTHER';
        amount: number;
        reference?: string;
        methodLabel?: string;
      }[];
      idempotencyKey?: string;
      creditDueDate?: string;
    },
  ) {
    if (!body.saleId) {
      throw new BadRequestException('saleId is required.');
    }
    return this.salesService.completeSale(
      req.user?.businessId || '',
      body.saleId,
      req.user?.sub || 'system',
      {
        payments: body.payments,
        idempotencyKey: body.idempotencyKey,
        creditDueDate: body.creditDueDate,
        userPermissions: req.user?.permissions ?? [],
      },
    );
  }

  @Post(':id/void')
  @Permissions(PermissionsList.SALES_WRITE)
  voidSale(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Param('id') id: string,
  ) {
    return this.salesService.voidSale(
      req.user?.businessId || '',
      id,
      req.user?.sub || 'system',
    );
  }

  @Post(':id/refund')
  @Permissions(PermissionsList.SALES_WRITE)
  refundSale(
    @Req()
    req: { user?: { businessId: string; sub?: string; roleIds?: string[] } },
    @Param('id') id: string,
    @Body()
    body: {
      reason?: string;
      returnToStock?: boolean;
      items?: { saleLineId: string; quantity: number }[];
    },
  ) {
    return this.salesService.refundSale(
      req.user?.businessId || '',
      id,
      req.user?.sub || 'system',
      req.user?.roleIds || [],
      body,
    );
  }

  @Post(':id/settlements')
  @Permissions(PermissionsList.SALE_CREDIT_SETTLE)
  recordSettlement(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: {
      amount: number;
      method: 'CASH' | 'CARD' | 'MOBILE_MONEY' | 'BANK_TRANSFER' | 'OTHER';
      reference?: string;
      methodLabel?: string;
    },
  ) {
    return this.salesService.recordSettlement(
      req.user?.businessId || '',
      id,
      req.user?.sub || 'system',
      body,
    );
  }

  @Post('returns/without-receipt')
  @Permissions(PermissionsList.RETURN_WITHOUT_RECEIPT)
  returnWithoutReceipt(
    @Req()
    req: { user?: { businessId: string; sub?: string; roleIds?: string[] } },
    @Body()
    body: {
      branchId: string;
      customerId?: string;
      reason?: string;
      returnToStock?: boolean;
      items: {
        variantId: string;
        quantity: number;
        unitPrice: number;
        unitId?: string;
      }[];
    },
  ) {
    return this.salesService.returnWithoutReceipt(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      req.user?.roleIds || [],
      body,
    );
  }

  @Get('receipts')
  @Permissions(PermissionsList.SALES_READ)
  listReceipts(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      search?: string;
      branchId?: string;
      customerId?: string;
      paymentMethod?: string;
      from?: string;
      to?: string;
      includeTotal?: string;
    },
  ) {
    return this.salesService.listReceipts(
      req.user?.businessId || '',
      query,
      req.user?.branchScope ?? [],
    );
  }

  @Post('receipts/:id/reprint')
  @Permissions(PermissionsList.SALES_READ)
  reprintReceipt(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Param('id') id: string,
  ) {
    return this.salesService.reprintReceipt(
      req.user?.businessId || '',
      id,
      req.user?.sub || 'system',
    );
  }
}
