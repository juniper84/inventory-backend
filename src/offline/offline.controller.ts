import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { OfflineService } from './offline.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';

@Controller('offline')
export class OfflineController {
  constructor(private readonly offlineService: OfflineService) {}

  @Post('register-device')
  @Permissions(PermissionsList.OFFLINE_WRITE)
  registerDevice(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { userId?: string; deviceName: string; deviceId?: string },
  ) {
    return this.offlineService.registerDevice(
      req.user?.businessId || '',
      req.user?.sub ?? body.userId ?? 'system',
      body.deviceName,
      body.deviceId,
    );
  }

  @Post('revoke-device')
  @Permissions(PermissionsList.OFFLINE_WRITE)
  revokeDevice(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { deviceId: string },
  ) {
    return this.offlineService.revokeDevice(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      body.deviceId,
    );
  }

  @Get('status')
  @Permissions(PermissionsList.OFFLINE_READ)
  status(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Query('deviceId') deviceId?: string,
  ) {
    return this.offlineService.getStatus(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      deviceId || '',
    );
  }

  @Get('risk')
  @Permissions(PermissionsList.OFFLINE_READ)
  risk(@Req() req: { user?: { businessId: string } }) {
    return this.offlineService.getRiskOverview(req.user?.businessId || '');
  }

  @Get('conflicts')
  @Permissions(PermissionsList.OFFLINE_READ)
  conflicts(
    @Req() req: { user?: { businessId: string } },
    @Query('deviceId') deviceId?: string,
    @Query() query?: { limit?: string; cursor?: string },
  ) {
    return this.offlineService.listConflicts(
      req.user?.businessId || '',
      deviceId || '',
      query,
    );
  }

  @Post('conflicts/resolve')
  @Permissions(PermissionsList.OFFLINE_WRITE)
  resolveConflict(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: {
      actionId: string;
      resolution?: 'DISMISS' | 'RETRY' | 'OVERRIDE_PRICE' | 'SYNC_APPROVAL';
    },
  ) {
    return this.offlineService.resolveConflict(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      body.actionId,
      body.resolution ?? 'DISMISS',
    );
  }

  @Post('status')
  @Permissions(PermissionsList.OFFLINE_WRITE)
  recordStatus(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: {
      deviceId: string;
      status: 'OFFLINE' | 'ONLINE';
      since?: string;
    },
  ) {
    return this.offlineService.recordStatus(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      body.deviceId,
      body.status,
      body.since,
    );
  }

  @Post('sync')
  @Permissions(PermissionsList.OFFLINE_WRITE)
  sync(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: {
      userId: string;
      deviceId: string;
      actions: {
        actionType: 'SALE_COMPLETE' | 'PURCHASE_DRAFT' | 'STOCK_ADJUSTMENT';
        payload: Record<string, unknown>;
        checksum: string;
        provisionalAt?: string;
        localAuditId?: string;
      }[];
    },
  ) {
    return this.offlineService.syncActions(
      req.user?.businessId || '',
      req.user?.sub || body.userId,
      body.deviceId,
      body.actions,
    );
  }
}
