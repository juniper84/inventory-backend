import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { BranchesService } from './branches.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';

@Controller('branches')
export class BranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  @Get()
  @Permissions(PermissionsList.SETTINGS_READ)
  list(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      search?: string;
      status?: string;
    },
  ) {
    return this.branchesService.list(
      req.user?.businessId || '',
      query,
      req.user?.branchScope ?? [],
    );
  }

  @Post()
  @Permissions(PermissionsList.SETTINGS_WRITE)
  create(
    @Req() req: { user?: { businessId: string } },
    @Body()
    body: {
      name: string;
      address?: string;
      phone?: string;
      priceListId?: string | null;
    },
  ) {
    if (!body.name?.trim()) {
      throw new BadRequestException('name is required.');
    }
    return this.branchesService.create(req.user?.businessId || '', body);
  }

  @Put(':id')
  @Permissions(PermissionsList.SETTINGS_WRITE)
  update(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string } },
    @Body()
    body: {
      name?: string;
      address?: string;
      phone?: string;
      priceListId?: string | null;
    },
  ) {
    return this.branchesService.update(req.user?.businessId || '', id, body);
  }
}
