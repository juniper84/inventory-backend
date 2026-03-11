import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { RolesService } from './roles.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { requireBusinessId, requireUserId } from '../common/request-context';

@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @Permissions(PermissionsList.ROLES_READ)
  list(
    @Req() req: { user?: { businessId: string } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      search?: string;
      scope?: string;
      permissionCount?: string;
    },
  ) {
    return this.rolesService.list(requireBusinessId(req), query);
  }

  @Get('permissions')
  @Permissions(PermissionsList.ROLES_READ)
  listPermissions() {
    return this.rolesService.listPermissions();
  }

  @Get(':id/permissions')
  @Permissions(PermissionsList.ROLES_READ)
  getRolePermissions(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string } },
  ) {
    return this.rolesService.getRolePermissions(requireBusinessId(req), id);
  }

  @Post()
  @Permissions(PermissionsList.ROLES_CREATE)
  create(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { name: string; approvalTier?: number },
  ) {
    return this.rolesService.create(requireBusinessId(req), requireUserId(req), body);
  }

  @Put(':id')
  @Permissions(PermissionsList.ROLES_UPDATE)
  update(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { name?: string; approvalTier?: number },
  ) {
    return this.rolesService.update(requireBusinessId(req), id, requireUserId(req), body);
  }

  @Put(':id/permissions')
  @Permissions(PermissionsList.ROLES_UPDATE)
  setRolePermissions(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { permissionIds: string[] },
  ) {
    return this.rolesService.setRolePermissions(
      requireBusinessId(req),
      id,
      requireUserId(req),
      body.permissionIds ?? [],
    );
  }
}
