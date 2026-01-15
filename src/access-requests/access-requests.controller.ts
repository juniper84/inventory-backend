import { BadRequestException, Body, Controller, Post, Req } from '@nestjs/common';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { AccessRequestsService } from './access-requests.service';

@Controller('access-requests')
export class AccessRequestsController {
  constructor(private readonly accessRequestsService: AccessRequestsService) {}

  @Post()
  @Permissions(PermissionsList.BUSINESS_READ)
  create(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { permission?: string; path?: string; reason?: string },
  ) {
    if (!body.reason?.trim()) {
      throw new BadRequestException('reason is required.');
    }
    return this.accessRequestsService.createRequest({
      businessId: req.user?.businessId || '',
      userId: req.user?.sub || '',
      permission: body.permission || 'unknown',
      path: body.path || '',
      reason: body.reason,
    });
  }
}
