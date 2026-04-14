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
import { SuppliersService } from './suppliers.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { requireBusinessId, requireUserId } from '../common/request-context';

@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliersService: SuppliersService) {}

  @Get()
  @Permissions(PermissionsList.SUPPLIERS_READ)
  list(
    @Req() req: { user?: { businessId: string } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      search?: string;
      status?: string;
      balanceDue?: string;
    },
  ) {
    return this.suppliersService.list(requireBusinessId(req), query);
  }

  @Post()
  @Permissions(PermissionsList.SUPPLIERS_WRITE)
  create(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: {
      name: string;
      phone?: string;
      email?: string;
      address?: string;
      notes?: string;
      leadTimeDays?: number;
      status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
    },
  ) {
    if (!body.name?.trim()) {
      throw new BadRequestException('name is required.');
    }
    return this.suppliersService.create(requireBusinessId(req), requireUserId(req), body);
  }

  @Get(':id/performance')
  @Permissions(PermissionsList.SUPPLIERS_READ)
  getPerformance(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string } },
  ) {
    return this.suppliersService.getSupplierPerformance(
      requireBusinessId(req),
      id,
    );
  }

  @Put(':id')
  @Permissions(PermissionsList.SUPPLIERS_WRITE)
  update(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: {
      name?: string;
      phone?: string;
      email?: string;
      address?: string;
      notes?: string;
      leadTimeDays?: number | null;
      status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
    },
  ) {
    return this.suppliersService.update(requireBusinessId(req), id, requireUserId(req), {
      ...body,
      leadTimeDays: body.leadTimeDays === null ? undefined : body.leadTimeDays,
    });
  }
}
