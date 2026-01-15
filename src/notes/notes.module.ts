import { Module } from '@nestjs/common';
import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';
import { NoteReminderWorker } from './notes.reminder.worker';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MailerModule } from '../mailer/mailer.module';
import { SubscriptionModule } from '../subscription/subscription.module';

@Module({
  imports: [AuditModule, NotificationsModule, MailerModule, SubscriptionModule],
  controllers: [NotesController],
  providers: [NotesService, NoteReminderWorker],
})
export class NotesModule {}
