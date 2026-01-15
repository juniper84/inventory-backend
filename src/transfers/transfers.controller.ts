import {
  Body,
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { TransfersService } from './transfers.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';

@Controller('transfers')
export class TransfersController {
  constructor(private readonly transfersService: TransfersService) {}

  @Get('pending')
  @Permissions(PermissionsList.TRANSFERS_READ)
  pending(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      sourceBranchId?: string;
      destinationBranchId?: string;
      includeTotal?: string;
    },
  ) {
    return this.transfersService.listPending(
      req.user?.businessId || '',
      query,
      req.user?.branchScope ?? [],
    );
  }

  @Get()
  @Permissions(PermissionsList.TRANSFERS_READ)
  list(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      status?: string;
      sourceBranchId?: string;
      destinationBranchId?: string;
      from?: string;
      to?: string;
      includeTotal?: string;
    },
  ) {
    return this.transfersService.list(
      req.user?.businessId || '',
      query,
      req.user?.branchScope ?? [],
    );
  }

  @Post()
  @Permissions(PermissionsList.TRANSFERS_WRITE)
  create(
    @Req()
    req: {
      user?: { businessId: string; sub?: string };
      headers?: Record<string, string | string[] | undefined>;
    },
    @Body()
    body: {
      sourceBranchId: string;
      destinationBranchId: string;
      items: { variantId: string; quantity: number; batchId?: string }[];
      feeAmount?: number;
      feeCurrency?: string;
      feeCarrier?: string;
      feeNote?: string;
      idempotencyKey?: string;
    },
  ) {
    const offlineHeader =
      req.headers?.['x-offline-mode'] ?? req.headers?.['x-offline'];
    if (offlineHeader === 'true' || offlineHeader === '1') {
      throw new ForbiddenException(
        'Transfers are not allowed in offline mode.',
      );
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      throw new BadRequestException('items are required.');
    }
    if (body.items.some((item) => Number.isNaN(Number(item.quantity)))) {
      throw new BadRequestException('item quantity must be a number.');
    }
    return this.transfersService.create(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      body,
    );
  }

  @Post(':id/approve')
  @Permissions(PermissionsList.TRANSFERS_WRITE)
  approve(
    @Param('id') id: string,
    @Req()
    req: {
      user?: {
        businessId: string;
        sub?: string;
        roleIds?: string[];
        branchScope?: string[];
      };
      headers?: Record<string, string | string[] | undefined>;
    },
  ) {
    const offlineHeader =
      req.headers?.['x-offline-mode'] ?? req.headers?.['x-offline'];
    if (offlineHeader === 'true' || offlineHeader === '1') {
      throw new ForbiddenException(
        'Transfers are not allowed in offline mode.',
      );
    }
    return this.transfersService.approve(
      req.user?.businessId || '',
      id,
      req.user?.sub || 'system',
      req.user?.roleIds || [],
      req.user?.branchScope ?? [],
    );
  }

  @Post(':id/receive')
  @Permissions(PermissionsList.TRANSFERS_WRITE)
  receive(
    @Param('id') id: string,
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
      headers?: Record<string, string | string[] | undefined>;
    },
    @Body()
    body?: {
      items?: { transferItemId: string; quantity: number }[];
      idempotencyKey?: string;
    },
  ) {
    const offlineHeader =
      req.headers?.['x-offline-mode'] ?? req.headers?.['x-offline'];
    if (offlineHeader === 'true' || offlineHeader === '1') {
      throw new ForbiddenException(
        'Transfers are not allowed in offline mode.',
      );
    }
    return this.transfersService.receive(
      req.user?.businessId || '',
      id,
      req.user?.sub || 'system',
      body?.items,
      body?.idempotencyKey,
      req.user?.branchScope ?? [],
    );
  }

  @Post(':id/cancel')
  @Permissions(PermissionsList.TRANSFERS_WRITE)
  cancel(
    @Param('id') id: string,
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
      headers?: Record<string, string | string[] | undefined>;
    },
  ) {
    const offlineHeader =
      req.headers?.['x-offline-mode'] ?? req.headers?.['x-offline'];
    if (offlineHeader === 'true' || offlineHeader === '1') {
      throw new ForbiddenException(
        'Transfers are not allowed in offline mode.',
      );
    }
    return this.transfersService.cancel(
      req.user?.businessId || '',
      id,
      req.user?.sub || 'system',
      req.user?.branchScope ?? [],
    );
  }
}
