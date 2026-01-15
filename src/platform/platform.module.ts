import { Module } from '@nestjs/common';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { PlatformBootstrap } from './platform.bootstrap';
import { BusinessModule } from '../business/business.module';
import { UsersModule } from '../users/users.module';
import { AuthModule } from '../auth/auth.module';
import { SupportAccessModule } from '../support-access/support-access.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    BusinessModule,
    UsersModule,
    AuthModule,
    SupportAccessModule,
    AuditModule,
    NotificationsModule,
  ],
  controllers: [PlatformController],
  providers: [PlatformService, PlatformBootstrap],
})
export class PlatformModule {}
