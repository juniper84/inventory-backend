import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ExportsService } from './exports.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { SubscriptionBypass } from '../subscription/subscription.guard';
import { requireBusinessId, requireUserId } from '../common/request-context';

@Controller('exports')
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}

  @Get('stock')
  @SubscriptionBypass()
  @Permissions(PermissionsList.EXPORTS_WRITE)
  exportStock(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Query('branchId') branchId?: string,
  ) {
    const branchScope = req.user?.branchScope ?? [];
    if (
      branchScope.length > 0 &&
      (!branchId || !branchScope.includes(branchId))
    ) {
      throw new BadRequestException(
        'Branch-scoped exports require a valid branch.',
      );
    }
    return this.exportsService.exportStockCsv(
      requireBusinessId(req),
      branchId,
    );
  }

  @Post('jobs')
  @SubscriptionBypass()
  @Permissions(PermissionsList.EXPORTS_WRITE)
  createJob(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
    },
    @Body()
    body: {
      type:
        | 'STOCK'
        | 'PRODUCTS'
        | 'OPENING_STOCK'
        | 'PRICE_UPDATES'
        | 'SUPPLIERS'
        | 'BRANCHES'
        | 'USERS'
        | 'AUDIT_LOGS'
        | 'CUSTOMER_REPORTS'
        | 'EXPORT_ON_EXIT';
      acknowledgement?: string;
      branchId?: string;
    },
  ) {
    return this.exportsService.createExportJob(
      requireBusinessId(req),
      requireUserId(req),
      body,
      req.user?.branchScope ?? [],
    );
  }

  @Get('jobs')
  @Permissions(PermissionsList.EXPORTS_WRITE)
  listJobs(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      search?: string;
      status?: string;
      type?: string;
      branchId?: string;
      from?: string;
      to?: string;
      includeTotal?: string;
    },
  ) {
    return this.exportsService.listJobs(
      requireBusinessId(req),
      query,
      req.user?.branchScope ?? [],
    );
  }

  @Post('jobs/:id/run')
  @Permissions(PermissionsList.EXPORTS_WRITE)
  runJob(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string } },
    @Body() body: { acknowledgement?: string },
  ) {
    return this.exportsService.runExportJob(
      id,
      requireBusinessId(req),
      body.acknowledgement,
    );
  }

  @Get('jobs/:id/download')
  @Permissions(PermissionsList.EXPORTS_WRITE)
  downloadJob(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string } },
  ) {
    return this.exportsService.downloadJob(id, requireBusinessId(req));
  }

  @Get('worker/status')
  @Permissions(PermissionsList.EXPORTS_WRITE)
  getWorkerStatus(@Req() req: { user?: { businessId: string } }) {
    return this.exportsService.getWorkerStatus(requireBusinessId(req));
  }
}
