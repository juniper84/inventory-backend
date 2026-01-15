import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { AttachmentsService } from './attachments.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';

@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachmentsService: AttachmentsService) {}

  @Post()
  @Permissions(PermissionsList.ATTACHMENTS_WRITE)
  create(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Body()
    body: {
      purchaseId?: string;
      purchaseOrderId?: string;
      filename: string;
      storageKey?: string;
      url: string;
      sizeMb?: number;
      mimeType?: string;
    },
  ) {
    return this.attachmentsService.create(
      req.user?.businessId || '',
      body,
      req.user?.branchScope ?? [],
    );
  }

  @Get()
  @Permissions(PermissionsList.ATTACHMENTS_WRITE)
  list(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      purchaseId?: string;
      purchaseOrderId?: string;
    },
  ) {
    return this.attachmentsService.list(
      req.user?.businessId || '',
      query,
      req.user?.branchScope ?? [],
    );
  }

  @Post('presign')
  @Permissions(PermissionsList.ATTACHMENTS_WRITE)
  presign(
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
    @Body()
    body: {
      purchaseId?: string;
      purchaseOrderId?: string;
      filename: string;
      mimeType?: string;
    },
  ) {
    return this.attachmentsService.createPresignedUpload(
      req.user?.businessId || '',
      body,
      req.user?.branchScope ?? [],
    );
  }

  @Post(':id/remove')
  @Permissions(PermissionsList.ATTACHMENTS_WRITE)
  remove(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; branchScope?: string[] } },
  ) {
    return this.attachmentsService.remove(
      req.user?.businessId || '',
      id,
      req.user?.branchScope ?? [],
    );
  }
}
