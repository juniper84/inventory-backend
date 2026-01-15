import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { StringValue } from 'ms';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { AuditModule } from '../audit/audit.module';
import { WhatsAppService } from './whatsapp.service';
import { SmsService } from './sms.service';
import { I18nModule } from '../i18n/i18n.module';
import { NotificationStreamService } from './notification-stream.service';

@Module({
  imports: [
    ConfigModule,
    AuditModule,
    I18nModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('jwt.secret'),
        signOptions: {
          expiresIn: (configService.get<string>('jwt.expiresIn') ??
            '15m') as StringValue,
        },
      }),
    }),
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationStreamService,
    WhatsAppService,
    SmsService,
  ],
  exports: [NotificationsService, NotificationStreamService],
})
export class NotificationsModule {}
