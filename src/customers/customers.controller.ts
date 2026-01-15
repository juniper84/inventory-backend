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
import { CustomersService } from './customers.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';

@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  @Permissions(PermissionsList.CUSTOMERS_VIEW)
  list(
    @Req()
    req: { user?: { businessId: string; permissions?: string[] } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      search?: string;
      status?: string;
      balanceDue?: string;
    },
  ) {
    const permissions = req.user?.permissions ?? [];
    const canViewSensitive = permissions.includes(
      PermissionsList.CUSTOMERS_VIEW_SENSITIVE,
    );
    return this.customersService.list(
      req.user?.businessId || '',
      canViewSensitive,
      query,
    );
  }

  @Get(':id')
  @Permissions(PermissionsList.CUSTOMERS_VIEW)
  get(
    @Param('id') id: string,
    @Req()
    req: { user?: { businessId: string; permissions?: string[] } },
  ) {
    const permissions = req.user?.permissions ?? [];
    const canViewSensitive = permissions.includes(
      PermissionsList.CUSTOMERS_VIEW_SENSITIVE,
    );
    return this.customersService.getById(
      req.user?.businessId || '',
      id,
      canViewSensitive,
    );
  }

  @Post()
  @Permissions(PermissionsList.CUSTOMERS_CREATE)
  create(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: {
      name: string;
      phone?: string;
      email?: string;
      tin?: string;
      notes?: string;
      status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
      priceListId?: string | null;
    },
  ) {
    if (!body.name?.trim()) {
      throw new BadRequestException('name is required.');
    }
    return this.customersService.create(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      body,
    );
  }

  @Put(':id')
  @Permissions(PermissionsList.CUSTOMERS_EDIT)
  update(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: {
      name?: string;
      phone?: string;
      email?: string;
      tin?: string;
      notes?: string;
      status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
      priceListId?: string | null;
    },
  ) {
    return this.customersService.update(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      id,
      body,
    );
  }

  @Post(':id/archive')
  @Permissions(PermissionsList.CUSTOMERS_EDIT)
  archive(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
  ) {
    return this.customersService.archive(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      id,
    );
  }

  @Post(':id/anonymize')
  @Permissions(PermissionsList.CUSTOMERS_ANONYMIZE)
  anonymize(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
  ) {
    return this.customersService.anonymize(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      id,
    );
  }

  @Get('export/csv')
  @Permissions(PermissionsList.CUSTOMERS_EXPORT)
  exportCsv(@Req() req: { user?: { businessId: string } }) {
    return this.customersService.exportCsv(req.user?.businessId || '');
  }
}
