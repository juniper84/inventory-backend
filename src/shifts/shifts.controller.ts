import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ShiftsService } from './shifts.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { requireBusinessId, requireUserId } from '../common/request-context';

@Controller('shifts')
export class ShiftsController {
  constructor(private readonly shiftsService: ShiftsService) {}

  @Get()
  @Permissions(PermissionsList.SHIFTS_OPEN)
  list(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      branchId?: string;
      status?: string;
    },
  ) {
    return this.shiftsService.list(
      requireBusinessId(req),
      query,
      req.user?.branchScope ?? [],
    );
  }

  @Get('open')
  @Permissions(PermissionsList.SHIFTS_OPEN)
  openShift(
    @Req() req: { user?: { businessId: string } },
    @Query('branchId') branchId?: string,
  ) {
    if (!branchId) {
      return null;
    }
    return this.shiftsService.getOpenShift(
      requireBusinessId(req),
      branchId,
    );
  }

  @Post('open')
  @Permissions(PermissionsList.SHIFTS_OPEN)
  open(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { branchId: string; openingCash: number; notes?: string },
  ) {
    return this.shiftsService.openShift(
      requireBusinessId(req),
      requireUserId(req),
      body,
    );
  }

  @Get(':id/performance')
  @Permissions(PermissionsList.SHIFTS_OPEN)
  getPerformance(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string } },
  ) {
    return this.shiftsService.getShiftPerformance(
      requireBusinessId(req),
      id,
    );
  }

  @Post(':id/close')
  @Permissions(PermissionsList.SHIFTS_CLOSE)
  close(
    @Param('id') id: string,
    @Req()
    req: { user?: { businessId: string; sub?: string; roleIds?: string[] } },
    @Body() body: { closingCash: number; varianceReason?: string },
  ) {
    return this.shiftsService.closeShift(
      requireBusinessId(req),
      requireUserId(req),
      req.user?.roleIds || [],
      id,
      body,
    );
  }
}
