import { BadRequestException, Body, Controller, Post, Req } from '@nestjs/common';
import { ImportsService } from './imports.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';

@Controller('imports')
export class ImportsController {
  constructor(private readonly importsService: ImportsService) {}

  @Post('preview')
  @Permissions(PermissionsList.EXPORTS_WRITE)
  preview(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: {
      type:
        | 'categories'
        | 'products'
        | 'opening_stock'
        | 'price_updates'
        | 'status_updates'
        | 'suppliers'
        | 'branches'
        | 'users';
      csv: string;
      options?: { createMissingCategories?: boolean };
    },
  ) {
    if (!body.type || !body.csv) {
      throw new BadRequestException('type and csv are required.');
    }
    return this.importsService.preview(req.user?.businessId || '', body);
  }

  @Post('apply')
  @Permissions(PermissionsList.EXPORTS_WRITE)
  apply(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: {
      type:
        | 'categories'
        | 'products'
        | 'opening_stock'
        | 'price_updates'
        | 'status_updates'
        | 'suppliers'
        | 'branches'
        | 'users';
      csv: string;
      options?: { createMissingCategories?: boolean };
    },
  ) {
    if (!body.type || !body.csv) {
      throw new BadRequestException('type and csv are required.');
    }
    return this.importsService.apply(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      body,
    );
  }
}
