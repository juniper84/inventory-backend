import { Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { UnitsService } from './units.service';
import { UnitType } from '@prisma/client';
import { requireBusinessId, requireUserId } from '../common/request-context';

@Controller('units')
export class UnitsController {
  constructor(private readonly unitsService: UnitsService) {}

  @Get()
  @Permissions(PermissionsList.CATALOG_READ)
  listUnits(@Req() req: { user?: { businessId: string } }) {
    return this.unitsService.listUnits(requireBusinessId(req));
  }

  @Post()
  @Permissions(PermissionsList.CATALOG_WRITE)
  createUnit(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { code: string; label: string; unitType?: UnitType },
  ) {
    return this.unitsService.createUnit(requireBusinessId(req), requireUserId(req), body);
  }

  @Put(':id')
  @Permissions(PermissionsList.CATALOG_WRITE)
  updateUnit(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { label?: string; code?: string },
  ) {
    return this.unitsService.updateUnit(requireBusinessId(req), id, requireUserId(req), body);
  }

  @Delete(':id')
  @Permissions(PermissionsList.CATALOG_WRITE)
  deleteUnit(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
  ) {
    return this.unitsService.deleteUnit(requireBusinessId(req), id, requireUserId(req));
  }
}
