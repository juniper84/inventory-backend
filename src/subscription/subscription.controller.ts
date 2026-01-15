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

@Controller('subscription')
export class SubscriptionController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  @Get()
  @Permissions(PermissionsList.SUBSCRIPTION_READ)
  getSubscription(@Req() req: { user?: { businessId: string } }) {
    return this.subscriptionService.getSubscriptionSummary(
      req.user?.businessId || '',
    );
  }

  @Get('requests')
  @Permissions(PermissionsList.SUBSCRIPTION_REQUEST)
  listRequests(@Req() req: { user?: { businessId: string } }) {
    return this.subscriptionService.listSubscriptionRequests(
      req.user?.businessId || '',
    );
  }

  @Post('requests')
  @Permissions(PermissionsList.SUBSCRIPTION_REQUEST)
  createRequest(
    @Req() req: { user?: { businessId?: string; sub?: string } },
    @Body()
    body: {
      type: 'UPGRADE' | 'DOWNGRADE' | 'CANCEL';
      requestedTier?: 'STARTER' | 'BUSINESS' | 'ENTERPRISE';
      reason?: string;
    },
  ) {
    if (!body.type) {
      throw new BadRequestException('type is required.');
    }
    return this.subscriptionService.createSubscriptionRequest(
      req.user?.businessId || '',
      req.user?.sub || 'system',
      body,
    );
  }
}
