import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { SubscriptionService } from './subscription.service';
import { SubscriptionController } from './subscription.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditModule } from '../audit/audit.module';
import { SubscriptionReminderService } from './subscription-reminder.service';
import { PlatformEventsModule } from '../platform/platform-events.module';

@Module({
  imports: [PrismaModule, ConfigModule, NotificationsModule, AuditModule, PlatformEventsModule],
  controllers: [SubscriptionController],
  providers: [SubscriptionService, SubscriptionReminderService],
  exports: [SubscriptionService],
})
export class SubscriptionModule {}
