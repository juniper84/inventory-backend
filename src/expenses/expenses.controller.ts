import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { ExpenseCategory } from '@prisma/client';

@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expensesService: ExpensesService) {}

  @Get()
  @Permissions(PermissionsList.EXPENSES_READ)
  list(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      search?: string;
      branchId?: string;
      category?: string;
      status?: string;
      from?: string;
      to?: string;
      includeTotal?: string;
    },
  ) {
    return this.expensesService.list(
      req.user?.businessId || '',
      query,
      req.user?.branchScope ?? [],
    );
  }

  @Post()
  @Permissions(PermissionsList.EXPENSES_WRITE)
  create(
    @Req()
    req: {
      user?: { businessId: string; sub?: string; roleIds?: string[] };
      headers?: Record<string, string | string[] | undefined>;
    },
    @Body()
    body: {
      branchId: string;
      category?: string;
      amount: number;
      currency?: string;
      expenseDate?: string;
      note?: string;
      receiptRef?: string;
    },
  ) {
    const offlineHeader =
      req.headers?.['x-offline-mode'] ?? req.headers?.['x-offline'];
    if (offlineHeader === 'true' || offlineHeader === '1') {
      throw new ForbiddenException('Expenses are not allowed in offline mode.');
    }
    if (body.category) {
      const validCategories = Object.values(ExpenseCategory) as string[];
      if (!validCategories.includes(body.category)) {
        throw new BadRequestException('Invalid expense category.');
      }
    }
    return this.expensesService.create(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      req.user?.roleIds || [],
      body,
    );
  }
}
