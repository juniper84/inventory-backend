import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { SearchService } from './search.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { requireBusinessId, requireUserId } from '../common/request-context';

@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @Permissions(PermissionsList.SEARCH_READ)
  search(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Query('q') query?: string,
  ) {
    return this.searchService.search(
      requireBusinessId(req),
      query ?? '',
      req.user?.branchScope ?? [],
    );
  }

  // ── Saved Searches ─────────────────────────────────────────────────

  @Get('saved')
  @Permissions(PermissionsList.SEARCH_READ)
  listSavedSearches(
    @Req() req: { user?: { businessId: string; sub?: string } },
  ) {
    return this.searchService.listSavedSearches(
      requireBusinessId(req),
      requireUserId(req),
    );
  }

  @Post('saved')
  @Permissions(PermissionsList.SEARCH_READ)
  createSavedSearch(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { name: string; query: string; filters?: Record<string, unknown> },
  ) {
    if (!body.name?.trim()) {
      throw new BadRequestException('name is required.');
    }
    if (!body.query?.trim()) {
      throw new BadRequestException('query is required.');
    }
    return this.searchService.createSavedSearch(
      requireBusinessId(req),
      requireUserId(req),
      body,
    );
  }

  @Delete('saved/:id')
  @Permissions(PermissionsList.SEARCH_READ)
  deleteSavedSearch(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; sub?: string } },
  ) {
    return this.searchService.deleteSavedSearch(
      requireBusinessId(req),
      requireUserId(req),
      id,
    );
  }

  // ── Popular Items ──────────────────────────────────────────────────

  @Get('popular')
  @Permissions(PermissionsList.SEARCH_READ)
  getPopularItems(
    @Req() req: { user?: { businessId: string } },
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50) : 10;
    return this.searchService.getPopularItems(
      requireBusinessId(req),
      parsedLimit,
    );
  }
}
