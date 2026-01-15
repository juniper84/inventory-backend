import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { UnitsService } from './units.service';
import { UnitType } from '@prisma/client';

@Controller('units')
export class UnitsController {
  constructor(private readonly unitsService: UnitsService) {}

  @Get()
  @Permissions(PermissionsList.CATALOG_READ)
  listUnits(@Req() req: { user?: { businessId: string } }) {
    return this.unitsService.listUnits(req.user?.businessId || '');
  }

  @Post()
  @Permissions(PermissionsList.CATALOG_WRITE)
  createUnit(
    @Req() req: { user?: { businessId: string } },
    @Body() body: { code: string; label: string; unitType?: UnitType },
  ) {
    return this.unitsService.createUnit(req.user?.businessId || '', body);
  }
}
