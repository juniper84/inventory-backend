import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Sse,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { NotificationStreamService } from './notification-stream.service';
import { Public } from '../auth/public.decorator';

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly notificationStream: NotificationStreamService,
  ) {}

  @Get()
  @Permissions(PermissionsList.NOTIFICATIONS_READ)
  list(
    @Req()
    req: {
      user?: {
        businessId: string;
        sub?: string;
        roleIds?: string[];
        branchScope?: string[];
        permissions?: string[];
      };
    },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      search?: string;
      status?: string;
      priority?: string;
      from?: string;
      to?: string;
      includeTotal?: string;
      includeArchived?: string;
    },
  ) {
    return this.notificationsService.list(
      req.user?.businessId || '',
      req.user?.sub,
      req.user?.roleIds ?? [],
      req.user?.branchScope ?? [],
      req.user?.permissions ?? [],
      query,
    );
  }

  @Post(':id/read')
  @Permissions(PermissionsList.NOTIFICATIONS_READ)
  markRead(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string } },
  ) {
    return this.notificationsService.markRead(req.user?.businessId || '', id);
  }

  @Post('read-all')
  @Permissions(PermissionsList.NOTIFICATIONS_READ)
  markAllRead(@Req() req: { user?: { businessId: string } }) {
    return this.notificationsService.markAllRead(req.user?.businessId || '');
  }

  @Post('read-bulk')
  @Permissions(PermissionsList.NOTIFICATIONS_READ)
  markBulkRead(
    @Req() req: { user?: { businessId: string } },
    @Body() body: { ids?: string[] },
  ) {
    return this.notificationsService.markBulkRead(
      req.user?.businessId || '',
      body.ids ?? [],
    );
  }

  @Post('archive-bulk')
  @Permissions(PermissionsList.NOTIFICATIONS_READ)
  archiveBulk(
    @Req() req: { user?: { businessId: string } },
    @Body() body: { ids?: string[] },
  ) {
    return this.notificationsService.archiveBulk(
      req.user?.businessId || '',
      body.ids ?? [],
    );
  }

  @Get('announcement')
  getAnnouncement(@Req() req: { user?: { businessId: string } }) {
    return this.notificationsService.getActiveAnnouncement(req.user?.businessId);
  }

  @Sse('stream')
  @Public()
  stream(@Query('token') token?: string) {
    return this.notificationStream.createStream(token ?? '');
  }
}
