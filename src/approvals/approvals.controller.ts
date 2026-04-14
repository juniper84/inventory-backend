import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { requireBusinessId, requireUserId } from '../common/request-context';

@Controller()
export class ApprovalsController {
  constructor(private readonly approvalsService: ApprovalsService) {}

  @Get('approval-policies')
  @Permissions(PermissionsList.APPROVALS_READ)
  listPolicies(
    @Req() req: { user?: { businessId: string } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      search?: string;
      status?: string;
    },
  ) {
    return this.approvalsService.listPolicies(
      requireBusinessId(req),
      query,
    );
  }

  @Post('approval-policies')
  @Permissions(PermissionsList.APPROVALS_WRITE)
  createPolicy(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body()
    body: {
      actionType: string;
      thresholdType?: 'NONE' | 'PERCENT' | 'AMOUNT';
      thresholdValue?: number | null;
      requiredRoleIds?: string[];
      allowSelfApprove?: boolean;
    },
  ) {
    return this.approvalsService.createPolicy(requireBusinessId(req), requireUserId(req), body);
  }

  @Put('approval-policies/:id')
  @Permissions(PermissionsList.APPROVALS_WRITE)
  updatePolicy(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Param('id') id: string,
    @Body()
    body: {
      thresholdType?: 'NONE' | 'PERCENT' | 'AMOUNT';
      thresholdValue?: number | null;
      requiredRoleIds?: string[];
      allowSelfApprove?: boolean;
    },
  ) {
    return this.approvalsService.updatePolicy(
      requireBusinessId(req),
      requireUserId(req),
      id,
      body,
    );
  }

  @Post('approval-policies/:id/archive')
  @Permissions(PermissionsList.APPROVALS_WRITE)
  archivePolicy(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Param('id') id: string,
  ) {
    return this.approvalsService.archivePolicy(requireBusinessId(req), requireUserId(req), id);
  }

  @Get('approvals')
  @Permissions(PermissionsList.APPROVALS_READ)
  listApprovals(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Query()
    query: {
      limit?: string;
      cursor?: string;
      search?: string;
      status?: string;
      actionType?: string;
      from?: string;
      to?: string;
      includeTotal?: string;
    },
  ) {
    return this.approvalsService.listApprovals(
      requireBusinessId(req),
      requireUserId(req),
      query,
    );
  }

  @Post('approvals/bulk-approve')
  @Permissions(PermissionsList.APPROVALS_WRITE)
  bulkApprove(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { approvalIds: string[] },
  ) {
    return this.approvalsService.bulkApprove(
      requireBusinessId(req),
      body.approvalIds ?? [],
      requireUserId(req),
    );
  }

  @Post('approvals/bulk-reject')
  @Permissions(PermissionsList.APPROVALS_WRITE)
  bulkReject(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Body() body: { approvalIds: string[]; reason?: string },
  ) {
    return this.approvalsService.bulkReject(
      requireBusinessId(req),
      body.approvalIds ?? [],
      requireUserId(req),
      body.reason,
    );
  }

  @Post('approvals/:id/approve')
  @Permissions(PermissionsList.APPROVALS_WRITE)
  approve(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Param('id') id: string,
  ) {
    return this.approvalsService.approve(
      requireBusinessId(req),
      id,
      requireUserId(req),
    );
  }

  @Post('approvals/:id/delegate')
  @Permissions(PermissionsList.APPROVALS_WRITE)
  delegate(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Param('id') id: string,
    @Body() body: { userId: string },
  ) {
    return this.approvalsService.delegate(
      requireBusinessId(req),
      id,
      requireUserId(req),
      body.userId,
    );
  }

  @Post('approvals/:id/reject')
  @Permissions(PermissionsList.APPROVALS_WRITE)
  reject(
    @Req() req: { user?: { businessId: string; sub?: string } },
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return this.approvalsService.reject(
      requireBusinessId(req),
      id,
      requireUserId(req),
      body.reason,
    );
  }
}
