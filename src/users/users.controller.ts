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
    return this.usersService.list(req.user?.businessId || '', query);
  }

  @Get('me')
  me(@Req() req: { user?: { businessId?: string; sub?: string } }) {
    return this.usersService.getProfile(
      req.user?.businessId || '',
      req.user?.sub || '',
    );
  }

  @Post()
  @Permissions(PermissionsList.USERS_CREATE)
  create(
    @Req() req: { user?: { businessId: string } },
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
    return this.usersService.create(req.user?.businessId || '', body);
  }

  @Put(':id')
  @Permissions(PermissionsList.USERS_UPDATE)
  update(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string } },
    @Body()
    body: {
      name?: string;
      email?: string;
      phone?: string | null;
      status?: string;
      notificationPreferences?: Record<string, unknown> | null;
    },
  ) {
    return this.usersService.update(req.user?.businessId || '', id, body);
  }

  @Post(':id/deactivate')
  @Permissions(PermissionsList.USERS_DEACTIVATE)
  deactivate(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string } },
  ) {
    return this.usersService.deactivate(req.user?.businessId || '', id);
  }

  @Post('invite')
  @Permissions(PermissionsList.USERS_CREATE)
  invite(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { email: string; roleId: string },
  ) {
    return this.usersService.invite(req.user?.businessId || '', {
      email: body.email,
      roleId: body.roleId,
      createdById: req.user?.sub,
    });
  }

  @Get(':id/roles')
  @Permissions(PermissionsList.USERS_READ)
  listUserRoles(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string } },
  ) {
    return this.usersService.listUserRoles(req.user?.businessId || '', id);
  }

  @Post(':id/roles')
  @Permissions(PermissionsList.USERS_UPDATE)
  addUserRole(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string } },
    @Body() body: { roleId: string; branchId?: string | null },
  ) {
    return this.usersService.addUserRole(
      req.user?.businessId || '',
      id,
      body.roleId,
      body.branchId ?? null,
    );
  }

  @Post(':id/roles/remove')
  @Permissions(PermissionsList.USERS_UPDATE)
  removeUserRole(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string } },
    @Body() body: { roleId: string; branchId?: string | null },
  ) {
    return this.usersService.removeUserRole(
      req.user?.businessId || '',
      id,
      body.roleId,
      body.branchId ?? null,
    );
  }
}
