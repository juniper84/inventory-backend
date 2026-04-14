import { Body, Controller, Headers, Ip, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/public.decorator';
import { SubscriptionBypass } from '../subscription/subscription.guard';
import { MarketingService } from './marketing.service';
import { CreateMarketingLeadDto } from './marketing.dto';

@Controller('marketing')
export class MarketingController {
  constructor(private readonly marketingService: MarketingService) {}

  @Post('leads')
  @Public()
  @SubscriptionBypass()
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  async createLead(
    @Body() dto: CreateMarketingLeadDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.marketingService.createLead(dto, {
      ipAddress: ip,
      userAgent,
    });
  }
}
