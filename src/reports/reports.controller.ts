import { Controller, Get, Query, Req } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { requireBusinessId, requireUserId } from '../common/request-context';

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
      requireBusinessId(req),
      requireUserId(req),
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
      requireBusinessId(req),
      requireUserId(req),
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
      requireBusinessId(req),
      requireUserId(req),
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
      requireBusinessId(req),
      requireUserId(req),
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
      requireBusinessId(req),
      requireUserId(req),
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
      requireBusinessId(req),
      requireUserId(req),
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
      requireBusinessId(req),
      requireUserId(req),
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
      requireBusinessId(req),
      requireUserId(req),
      { days, limit, branchId },
      req.user?.branchScope ?? [],
    );
  }

  @Get('top-products')
  @Permissions(PermissionsList.REPORTS_READ)
  topProducts(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
    },
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branchId') branchId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.reportsService.topProductsReport(
      requireBusinessId(req),
      requireUserId(req),
      { startDate, endDate, branchId, limit },
      req.user?.branchScope ?? [],
    );
  }

  @Get('sales-by-branch')
  @Permissions(PermissionsList.REPORTS_READ)
  salesByBranch(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
    },
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportsService.salesByBranchReport(
      requireBusinessId(req),
      requireUserId(req),
      { startDate, endDate, branchId },
      req.user?.branchScope ?? [],
    );
  }

  @Get('expenses/breakdown')
  @Permissions(PermissionsList.REPORTS_READ)
  expenseBreakdown(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
    },
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branchId') branchId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.reportsService.expenseBreakdownReport(
      requireBusinessId(req),
      requireUserId(req),
      { startDate, endDate, branchId, limit },
      req.user?.branchScope ?? [],
    );
  }

  @Get('recent-activity')
  @Permissions(PermissionsList.REPORTS_READ)
  recentActivity(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
    },
    @Query('branchId') branchId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.reportsService.recentActivityReport(
      requireBusinessId(req),
      requireUserId(req),
      { branchId, limit },
      req.user?.branchScope ?? [],
    );
  }

  @Get('stock-value')
  @Permissions(PermissionsList.REPORTS_READ)
  stockValue(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; branchScope?: string[] };
    },
    @Query('branchId') branchId?: string,
  ) {
    return this.reportsService.stockValueReport(
      requireBusinessId(req),
      requireUserId(req),
      { branchId },
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
      requireBusinessId(req),
      requireUserId(req),
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
      requireBusinessId(req),
      requireUserId(req),
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
      requireBusinessId(req),
      requireUserId(req),
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
      requireBusinessId(req),
      requireUserId(req),
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
      requireBusinessId(req),
      requireUserId(req),
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
      requireBusinessId(req),
      requireUserId(req),
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
      requireBusinessId(req),
      requireUserId(req),
      { startDate, endDate, branchId },
      req.user?.branchScope ?? [],
    );
  }
}
