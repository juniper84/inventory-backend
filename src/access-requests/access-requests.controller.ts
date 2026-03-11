import { Body, Controller, Post, Req } from '@nestjs/common';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { AccessRequestsService } from './access-requests.service';
import { requireBusinessId, requireUserId } from '../common/request-context';

@Controller('access-requests')
export class AccessRequestsController {
  constructor(private readonly accessRequestsService: AccessRequestsService) {}

  @Post()
  @Permissions(PermissionsList.BUSINESS_READ)
  create(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { permission?: string; path?: string; reason?: string },
  ) {
    return this.accessRequestsService.createRequest({
      businessId: requireBusinessId(req),
      userId: requireUserId(req),
      permission: body.permission || 'unknown',
      path: body.path || '',
      reason: body.reason,
    });
  }
}
