import { Body, Controller, Get, Post, Put, Req } from '@nestjs/common';
import { BusinessService } from './business.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { requireBusinessId, requireUserId } from '../common/request-context';

@Controller('business')
export class BusinessController {
  constructor(private readonly businessService: BusinessService) {}

  @Get()
  @Permissions(PermissionsList.BUSINESS_READ)
  async getBusiness(@Req() req: { user?: { businessId: string } }) {
    return this.businessService.getBusiness(requireBusinessId(req));
  }

  @Put()
  @Permissions(PermissionsList.BUSINESS_UPDATE)
  async updateBusiness(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { name?: string; defaultLanguage?: string },
  ) {
    return this.businessService.updateBusiness(
      requireBusinessId(req),
      requireUserId(req),
      body,
    );
  }

  @Post('delete')
  @Permissions(PermissionsList.BUSINESS_DELETE)
  async deleteBusiness(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: { businessId: string; password: string; confirmText: string },
  ) {
    return this.businessService.deleteBusinessByOwner({
      businessId: requireBusinessId(req),
      userId: requireUserId(req),
      password: body.password,
      confirmBusinessId: body.businessId,
      confirmText: body.confirmText,
    });
  }
}
