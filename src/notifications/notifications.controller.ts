import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Sse,
  UnauthorizedException,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { NotificationStreamService } from './notification-stream.service';
import { Public } from '../auth/public.decorator';
import { JwtPayload } from '../auth/auth.types';
import { requireBusinessId, requireUserId } from '../common/request-context';
import { SubscriptionBypass } from '../subscription/subscription.guard';

@Controller('notifications')
@SubscriptionBypass()
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
      requireBusinessId(req),
      requireUserId(req),
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
    @Req() req: { user?: { businessId: string; sub?: string } },
  ) {
    return this.notificationsService.markRead(
      requireBusinessId(req),
      id,
      requireUserId(req),
    );
  }

  @Post('read-all')
  @Permissions(PermissionsList.NOTIFICATIONS_READ)
  markAllRead(@Req() req: { user?: { businessId: string; sub?: string } }) {
    return this.notificationsService.markAllRead(
      requireBusinessId(req),
      requireUserId(req),
    );
  }

  @Post('read-bulk')
  @Permissions(PermissionsList.NOTIFICATIONS_READ)
  markBulkRead(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { ids?: string[] },
  ) {
    return this.notificationsService.markBulkRead(
      requireBusinessId(req),
      requireUserId(req),
      body.ids ?? [],
    );
  }

  @Post('archive-bulk')
  @Permissions(PermissionsList.NOTIFICATIONS_READ)
  archiveBulk(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { ids?: string[] },
  ) {
    return this.notificationsService.archiveBulk(
      requireBusinessId(req),
      requireUserId(req),
      body.ids ?? [],
    );
  }

  @Get('announcement')
  getAnnouncement(@Req() req: { user?: { businessId: string } }) {
    return this.notificationsService.getActiveAnnouncement(
      requireBusinessId(req),
    );
  }

  @Get('announcements')
  getAnnouncements(@Req() req: { user?: { businessId: string } }) {
    return this.notificationsService.getActiveAnnouncements(
      requireBusinessId(req),
    );
  }

  @Post('stream-token')
  @Permissions(PermissionsList.NOTIFICATIONS_READ)
  async getStreamToken(@Req() req: { user?: JwtPayload }) {
    if (!req.user) {
      throw new UnauthorizedException();
    }
    const token = await this.notificationStream.generateStreamToken(req.user);
    return { token };
  }

  @Sse('stream')
  @Public()
  async stream(@Query('token') token?: string) {
    return this.notificationStream.createStream(token ?? '');
  }
}
