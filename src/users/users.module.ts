import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { SubscriptionModule } from '../subscription/subscription.module';
import { MailerModule } from '../mailer/mailer.module';
import { I18nModule } from '../i18n/i18n.module';

@Module({
  imports: [SubscriptionModule, MailerModule, I18nModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
