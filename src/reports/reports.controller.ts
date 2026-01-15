import { Controller, Get, Query, Req } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('stock')
  @Permissions(PermissionsList.REPORTS_READ)
  stock(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
    },
    @Query('branchId') branchId?: string,
  ) {
    return this.reportsService.stockReport(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      { branchId },
      req.user?.branchScope ?? [],
    );
  }

  @Get('sales')
  @Permissions(PermissionsList.REPORTS_READ)
  sales(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
    },
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportsService.salesReport(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      {
        startDate,
        endDate,
        branchId,
      },
      req.user?.branchScope ?? [],
    );
  }

  @Get('vat')
  @Permissions(PermissionsList.REPORTS_READ)
  vat(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
    },
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportsService.vatReport(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      {
        startDate,
        endDate,
        branchId,
      },
      req.user?.branchScope ?? [],
    );
  }

  @Get('vat-summary')
  @Permissions(PermissionsList.REPORTS_READ)
  vatSummary(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
    },
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportsService.vatSummaryReport(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      {
        startDate,
        endDate,
        branchId,
      },
      req.user?.branchScope ?? [],
    );
  }

  @Get('pnl')
  @Permissions(PermissionsList.REPORTS_READ)
  pnl(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
    },
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportsService.pnlReport(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      {
        startDate,
        endDate,
        branchId,
      },
      req.user?.branchScope ?? [],
    );
  }

  @Get('low-stock')
  @Permissions(PermissionsList.REPORTS_READ)
  lowStock(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
    },
    @Query('threshold') threshold?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportsService.lowStockReport(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      {
        threshold,
        branchId,
      },
      req.user?.branchScope ?? [],
    );
  }

  @Get('expiry')
  @Permissions(PermissionsList.REPORTS_READ)
  expiry(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
    },
    @Query('days') days?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportsService.expiryReport(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      { days, branchId },
      req.user?.branchScope ?? [],
    );
  }

  @Get('losses/top')
  @Permissions(PermissionsList.REPORTS_READ)
  topLosses(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
    },
    @Query('days') days?: string,
    @Query('limit') limit?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportsService.topLossesReport(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      { days, limit, branchId },
      req.user?.branchScope ?? [],
    );
  }

  @Get('stock-count-variance')
  @Permissions(PermissionsList.REPORTS_READ)
  stockCountVariance(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
    },
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportsService.stockCountVarianceReport(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      { from, to, branchId },
      req.user?.branchScope ?? [],
    );
  }

  @Get('staff')
  @Permissions(PermissionsList.REPORTS_READ)
  staffPerformance(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
    },
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportsService.staffPerformance(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      { startDate, endDate, branchId },
      req.user?.branchScope ?? [],
    );
  }

  @Get('customers/sales')
  @Permissions(PermissionsList.REPORTS_READ)
  customerSales(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
    },
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportsService.customerSalesReport(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      {
        startDate,
        endDate,
        branchId,
      },
      req.user?.branchScope ?? [],
    );
  }

  @Get('customers/refunds')
  @Permissions(PermissionsList.REPORTS_READ)
  customerRefunds(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
    },
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportsService.customerRefundsReport(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      {
        startDate,
        endDate,
        branchId,
      },
      req.user?.branchScope ?? [],
    );
  }

  @Get('customers/outstanding')
  @Permissions(PermissionsList.REPORTS_READ)
  customerOutstanding(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
    },
    @Query('branchId') branchId?: string,
  ) {
    return this.reportsService.customerOutstandingReport(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      { branchId },
      req.user?.branchScope ?? [],
    );
  }

  @Get('customers/top')
  @Permissions(PermissionsList.REPORTS_READ)
  topCustomers(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
    },
    @Query('branchId') branchId?: string,
  ) {
    return this.reportsService.topCustomersReport(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      { branchId },
      req.user?.branchScope ?? [],
    );
  }

  @Get('customers/export')
  @Permissions(PermissionsList.REPORTS_READ)
  exportCustomerReport(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
    },
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportsService.customerReportsCsv(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      { startDate, endDate, branchId },
      req.user?.branchScope ?? [],
    );
  }
}
