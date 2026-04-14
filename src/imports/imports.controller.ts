import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ImportsService } from './imports.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { requireBusinessId, requireUserId } from '../common/request-context';

@Controller('imports')
export class ImportsController {
  constructor(private readonly importsService: ImportsService) {}

  // P2-G2-M3: Maximum allowed CSV size is 10 MB to prevent OOM during parsing.
  private static readonly MAX_CSV_BYTES = 10 * 1024 * 1024;

  @Get('template')
  @Permissions(PermissionsList.IMPORTS_WRITE)
  getTemplate(
    @Req() req: { user?: { businessId: string } },
    @Query('type') type: string,
  ) {
    const validTypes = ['opening_stock', 'price_updates', 'status_updates', 'stock_counts'];
    if (!validTypes.includes(type)) {
      throw new BadRequestException(`Template type must be one of: ${validTypes.join(', ')}`);
    }
    return this.importsService.generatePrefilledTemplate(
      requireBusinessId(req),
      type as 'opening_stock' | 'price_updates' | 'status_updates' | 'stock_counts',
    );
  }

  @Get('history')
  @Permissions(PermissionsList.IMPORTS_WRITE)
  listHistory(@Req() req: { user?: { businessId: string } }) {
    return this.importsService.listHistory(requireBusinessId(req));
  }

  @Post('preview')
  @Permissions(PermissionsList.IMPORTS_WRITE)
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
        | 'users'
        | 'customers'
        | 'units'
        | 'stock_counts';
      csv: string;
      options?: { createMissingCategories?: boolean };
    },
  ) {
    if (!body.type || !body.csv) {
      throw new BadRequestException('type and csv are required.');
    }
    if (Buffer.byteLength(body.csv, 'utf8') > ImportsController.MAX_CSV_BYTES) {
      throw new BadRequestException('CSV file exceeds the 10 MB size limit.');
    }
    return this.importsService.preview(requireBusinessId(req), body);
  }

  @Post('apply')
  @Permissions(PermissionsList.IMPORTS_WRITE)
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
        | 'users'
        | 'customers'
        | 'units'
        | 'stock_counts';
      csv: string;
      options?: { createMissingCategories?: boolean };
    },
  ) {
    if (!body.type || !body.csv) {
      throw new BadRequestException('type and csv are required.');
    }
    if (Buffer.byteLength(body.csv, 'utf8') > ImportsController.MAX_CSV_BYTES) {
      throw new BadRequestException('CSV file exceeds the 10 MB size limit.');
    }
    return this.importsService.apply(
      requireBusinessId(req),
      requireUserId(req),
      body,
    );
  }
}
