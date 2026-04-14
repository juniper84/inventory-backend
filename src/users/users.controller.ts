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
import { UsersService } from './users.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { requireBusinessId, requireUserId } from '../common/request-context';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @Permissions(PermissionsList.USERS_READ)
  list(
    @Req() req: { user?: { businessId: string } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      search?: string;
      status?: string;
      roleId?: string;
    },
  ) {
    return this.usersService.list(requireBusinessId(req), query);
  }

  @Get('me')
  me(@Req() req: { user?: { businessId?: string; sub?: string } }) {
    return this.usersService.getProfile(
      requireBusinessId(req),
      requireUserId(req),
    );
  }

  @Post()
  @Permissions(PermissionsList.USERS_CREATE)
  create(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: {
      name: string;
      email: string;
      phone?: string | null;
      status?: string;
      tempPassword?: string;
      mustResetPassword?: boolean;
    },
  ) {
    return this.usersService.create(requireBusinessId(req), requireUserId(req), body);
  }

  @Put(':id')
  @Permissions(PermissionsList.USERS_UPDATE)
  update(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: {
      name?: string;
      email?: string;
      phone?: string | null;
      status?: string;
      notificationPreferences?: Record<string, unknown> | null;
    },
  ) {
    return this.usersService.update(requireBusinessId(req), id, requireUserId(req), body);
  }

  @Post(':id/deactivate')
  @Permissions(PermissionsList.USERS_DEACTIVATE)
  deactivate(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
  ) {
    return this.usersService.deactivate(requireBusinessId(req), id, requireUserId(req));
  }

  @Post('invite')
  @Permissions(PermissionsList.USERS_CREATE)
  invite(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { email: string; roleId: string; branchIds?: string[]; name?: string; phone?: string },
  ) {
    return this.usersService.invite(requireBusinessId(req), {
      email: body.email,
      roleId: body.roleId,
      branchIds: body.branchIds,
      name: body.name,
      phone: body.phone,
      createdById: requireUserId(req),
    });
  }

  @Get(':id/activity')
  @Permissions(PermissionsList.USERS_READ)
  getUserActivity(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string } },
  ) {
    return this.usersService.getUserActivity(requireBusinessId(req), id);
  }

  @Get(':id/login-history')
  @Permissions(PermissionsList.USERS_READ)
  getLoginHistory(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string } },
  ) {
    return this.usersService.getLoginHistory(requireBusinessId(req), id);
  }

  @Get(':id/roles')
  @Permissions(PermissionsList.USERS_READ)
  listUserRoles(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string } },
  ) {
    return this.usersService.listUserRoles(requireBusinessId(req), id);
  }

  @Post(':id/roles')
  @Permissions(PermissionsList.USERS_UPDATE)
  addUserRole(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { roleId: string; branchId?: string | null },
  ) {
    return this.usersService.addUserRole(
      requireBusinessId(req),
      id,
      body.roleId,
      requireUserId(req),
      body.branchId ?? null,
    );
  }

  @Post(':id/roles/remove')
  @Permissions(PermissionsList.USERS_UPDATE)
  removeUserRole(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { roleId: string; branchId?: string | null },
  ) {
    return this.usersService.removeUserRole(
      requireBusinessId(req),
      id,
      body.roleId,
      requireUserId(req),
      body.branchId ?? null,
    );
  }
}
