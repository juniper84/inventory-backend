import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { SupportAccessService } from './support-access.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';

@Controller('support-access')
export class SupportAccessController {
  constructor(private readonly supportAccessService: SupportAccessService) {}

  @Get('requests')
  @Permissions(PermissionsList.SETTINGS_READ)
  listRequests(
    @Req() req: { user?: { businessId: string } },
    @Query() query: { limit?: string; cursor?: string; status?: string },
  ) {
    return this.supportAccessService.listRequestsForBusiness(
      req.user?.businessId || '',
      query,
    );
  }

  @Post('requests/:id/approve')
  @Permissions(PermissionsList.SETTINGS_WRITE)
  approveRequest(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Param('id') id: string,
    @Body() body: { durationHours?: number; decisionNote?: string },
  ) {
    return this.supportAccessService.approveRequest({
      businessId: req.user?.businessId || '',
      requestId: id,
      approvedByUserId: req.user?.sub || '',
      durationHours: body.durationHours,
      decisionNote: body.decisionNote,
    });
  }

  @Post('requests/:id/reject')
  @Permissions(PermissionsList.SETTINGS_WRITE)
  rejectRequest(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Param('id') id: string,
    @Body() body: { decisionNote?: string },
  ) {
    return this.supportAccessService.rejectRequest({
      businessId: req.user?.businessId || '',
      requestId: id,
      approvedByUserId: req.user?.sub || '',
      decisionNote: body.decisionNote,
    });
  }
}
