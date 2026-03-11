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
import { PriceListsService } from './price-lists.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { requireBusinessId, requireUserId } from '../common/request-context';

@Controller('price-lists')
export class PriceListsController {
  constructor(private readonly priceListsService: PriceListsService) {}

  @Get()
  @Permissions(PermissionsList.PRICE_LISTS_MANAGE)
  list(
    @Req() req: { user?: { businessId: string } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      search?: string;
      status?: string;
    },
  ) {
    return this.priceListsService.list(requireBusinessId(req), query);
  }

  @Post()
  @Permissions(PermissionsList.PRICE_LISTS_MANAGE)
  create(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { name: string },
  ) {
    if (!body.name?.trim()) {
      throw new BadRequestException('name is required.');
    }
    return this.priceListsService.create(
      requireBusinessId(req),
      requireUserId(req),
      body,
    );
  }

  @Put(':id')
  @Permissions(PermissionsList.PRICE_LISTS_MANAGE)
  update(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: { name?: string; status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' },
  ) {
    return this.priceListsService.update(
      requireBusinessId(req),
      requireUserId(req),
      id,
      body,
    );
  }

  @Post(':id/items')
  @Permissions(PermissionsList.PRICE_LISTS_MANAGE)
  setItem(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { variantId: string; price: number },
  ) {
    return this.priceListsService.setItem(
      requireBusinessId(req),
      requireUserId(req),
      id,
      body,
    );
  }

  @Post(':id/items/:itemId/remove')
  @Permissions(PermissionsList.PRICE_LISTS_MANAGE)
  removeItem(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
  ) {
    return this.priceListsService.removeItem(
      requireBusinessId(req),
      requireUserId(req),
      id,
      itemId,
    );
  }
}
