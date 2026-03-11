import { Controller, Get, Query, Req } from '@nestjs/common';
import { SearchService } from './search.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { requireBusinessId } from '../common/request-context';

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
}
