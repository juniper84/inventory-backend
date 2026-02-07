import { Module } from '@nestjs/common';
import { AccessRequestsController } from './access-requests.controller';
import { AccessRequestsService } from './access-requests.service';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [PrismaModule, NotificationsModule, AuditModule, RbacModule],
  controllers: [AccessRequestsController],
  providers: [AccessRequestsService],
})
export class AccessRequestsModule {}
