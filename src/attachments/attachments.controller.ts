import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { AttachmentsService } from './attachments.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { requireBusinessId, requireUserId } from '../common/request-context';

@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachmentsService: AttachmentsService) {}

  @Post()
  @Permissions(PermissionsList.ATTACHMENTS_WRITE)
  create(
    @Req() req: { user?: { businessId: string; sub?: string; branchScope?: string[] } },
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
      requireBusinessId(req),
      requireUserId(req),
      body,
      req.user?.branchScope ?? [],
    );
  }

  @Get()
  @Permissions(PermissionsList.ATTACHMENTS_READ)
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
      requireBusinessId(req),
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
      requireBusinessId(req),
      body,
      req.user?.branchScope ?? [],
    );
  }

  @Post(':id/remove')
  @Permissions(PermissionsList.ATTACHMENTS_WRITE)
  remove(
    @Param('id') id: string,
    @Req() req: { user?: { businessId: string; sub?: string; branchScope?: string[] } },
  ) {
    return this.attachmentsService.remove(
      requireBusinessId(req),
      id,
      requireUserId(req),
      req.user?.branchScope ?? [],
    );
  }
}
