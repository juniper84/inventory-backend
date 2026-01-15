import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';

@Module({
  imports: [ApprovalsModule, NotificationsModule],
  controllers: [TransfersController],
  providers: [TransfersService],
})
export class TransfersModule {}
