import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
} from '@nestjs/common';
import { SubscriptionService } from './subscription.service';
import { Permissions } from '../rbac/permissions.decorator';
import { PermissionsList } from '../rbac/permissions';
import { requireBusinessId, requireUserId } from '../common/request-context';
import { SubscriptionBypass } from './subscription.guard';

@Controller('subscription')
export class SubscriptionController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  @Get()
  @Permissions(PermissionsList.SUBSCRIPTION_READ)
  getSubscription(@Req() req: { user?: { businessId: string } }) {
    return this.subscriptionService.getSubscriptionSummary(
      requireBusinessId(req),
    );
  }

  @Get('requests')
  @Permissions(PermissionsList.SUBSCRIPTION_REQUEST)
  listRequests(@Req() req: { user?: { businessId: string } }) {
    return this.subscriptionService.listSubscriptionRequests(
      requireBusinessId(req),
    );
  }

  @Post('requests')
  @SubscriptionBypass()
  @Permissions(PermissionsList.SUBSCRIPTION_REQUEST)
  createRequest(
    @Req() req: { user?: { businessId?: string; sub?: string } },
    @Body()
    body: {
      type: 'UPGRADE' | 'DOWNGRADE' | 'CANCEL' | 'SUBSCRIBE';
      requestedTier?: 'STARTER' | 'BUSINESS' | 'ENTERPRISE';
      reason?: string;
      requestedDurationMonths?: number;
    },
  ) {
    if (!body.type) {
      throw new BadRequestException('type is required.');
    }
    if (body.type === 'DOWNGRADE') {
      throw new BadRequestException('Downgrade requests are not supported.');
    }
    return this.subscriptionService.createSubscriptionRequest(
      requireBusinessId(req),
      requireUserId(req),
      body,
    );
  }
}
