import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { requireBusinessId, requireUserId } from '../common/request-context';
import { VALID_CURRENCY_CODES } from '../common/currency-codes';

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
      requireBusinessId(req),
      query,
      req.user?.branchScope ?? [],
    );
  }

  @Get('categories')
  @Permissions(PermissionsList.EXPENSES_READ)
  listCategories(@Req() req: { user?: { businessId: string } }) {
    return this.expensesService.listCategories(requireBusinessId(req));
  }

  @Post('categories')
  @Permissions(PermissionsList.EXPENSES_WRITE)
  createCategory(
    @Req() req: { user?: { businessId: string } },
    @Body() body: { code: string; label: string },
  ) {
    if (!body.code?.trim() || !body.label?.trim()) {
      throw new BadRequestException('code and label are required.');
    }
    return this.expensesService.createCategory(requireBusinessId(req), {
      code: body.code.trim().toUpperCase(),
      label: body.label.trim(),
    });
  }

  @Delete('categories/:id')
  @Permissions(PermissionsList.EXPENSES_WRITE)
  deleteCategory(
    @Req() req: { user?: { businessId: string } },
    @Param('id') id: string,
  ) {
    return this.expensesService.deleteCategory(requireBusinessId(req), id);
  }

  @Put('categories/:id')
  @Permissions(PermissionsList.EXPENSES_WRITE)
  updateCategory(
    @Req() req: { user?: { businessId: string } },
    @Param('id') id: string,
    @Body() body: { label?: string; code?: string },
  ) {
    return this.expensesService.updateCategory(requireBusinessId(req), id, body);
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
      title?: string;
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
    if (body.currency && !VALID_CURRENCY_CODES.has(body.currency.toUpperCase())) {
      throw new BadRequestException('Invalid currency code.');
    }
    return this.expensesService.create(
      requireBusinessId(req),
      requireUserId(req),
      req.user?.roleIds || [],
      body,
    );
  }
}
