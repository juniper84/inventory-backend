import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { AuditService } from '../audit/audit.service';

const REMINDER_POLL_MS = 60_000;
const MAX_BATCH = 50;
const CHANNEL_RULES: Record<string, Array<'IN_APP' | 'EMAIL' | 'WHATSAPP'>> = {
  STARTER: [],
  BUSINESS: ['IN_APP', 'EMAIL'],
  ENTERPRISE: ['IN_APP', 'EMAIL', 'WHATSAPP'],
};

@Injectable()
export class NoteReminderWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly subscriptionService: SubscriptionService,
    private readonly auditService: AuditService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.processDueReminders();
    }, REMINDER_POLL_MS);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async processDueReminders() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const now = new Date();
      const reminders = await this.prisma.noteReminder.findMany({
        where: {
          status: 'SCHEDULED',
          scheduledAt: { lte: now },
        },
        include: {
          note: true,
          recipient: true,
          createdBy: true,
          branch: true,
        },
        orderBy: { scheduledAt: 'asc' },
        take: MAX_BATCH,
      });

      for (const reminder of reminders) {
        await this.deliverReminder(reminder);
      }
    } finally {
      this.running = false;
    }
  }

  private async deliverReminder(reminder: {
    id: string;
    businessId: string;
    noteId: string;
    channel: 'IN_APP' | 'EMAIL' | 'WHATSAPP';
    branchId: string | null;
    scheduledAt: Date;
    note: {
      id: string;
      title: string;
      body: string;
      status: string;
      authorId: string;
    };
    recipient: { id: string; name: string | null; email: string | null } | null;
    createdBy: { id: string };
  }) {
    if (reminder.note.status !== 'ACTIVE') {
      await this.markCancelled(reminder.id, 'Note is archived.');
      return;
    }

    const subscription = await this.subscriptionService.getSubscription(
      reminder.businessId,
    );
    const tier = subscription?.tier ?? null;
    const allowedChannels = tier ? (CHANNEL_RULES[tier] ?? []) : [];
    if (!allowedChannels.includes(reminder.channel)) {
      await this.markCancelled(reminder.id, 'Reminder channel not allowed.');
      return;
    }
    const remindersEnabled = await this.notificationsService.isEventEnabled(
      reminder.businessId,
      'noteReminder',
    );
    if (!remindersEnabled) {
      await this.markCancelled(reminder.id, 'Reminder notifications disabled.');
      return;
    }

    const title = `Reminder: ${reminder.note.title}`.slice(0, 140);
    const message =
      reminder.note.body.length > 600
        ? `${reminder.note.body.slice(0, 600).trim()}…`
        : reminder.note.body;

    try {
      const channelOverrides: Partial<
        Record<'email' | 'sms' | 'whatsapp', boolean>
      > = { sms: false };
      if (reminder.channel === 'IN_APP') {
        channelOverrides.email = false;
        channelOverrides.whatsapp = false;
      } else if (reminder.channel === 'EMAIL') {
        channelOverrides.whatsapp = false;
      } else if (reminder.channel === 'WHATSAPP') {
        channelOverrides.email = false;
      }
      await this.notificationsService.notifyEvent({
        businessId: reminder.businessId,
        eventKey: 'noteReminder',
        recipientUserIds: [reminder.recipient?.id ?? reminder.note.authorId],
        branchId: reminder.branchId ?? undefined,
        title,
        message,
        priority: 'INFO',
        metadata: {
          resourceType: 'Note',
          resourceId: reminder.noteId,
        },
        channelOverrides,
      });

      await this.prisma.noteReminder.update({
        where: { id: reminder.id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          lastAttemptAt: new Date(),
          attemptCount: { increment: 1 },
          lastError: null,
        },
      });
      await this.auditService.logEvent({
        businessId: reminder.businessId,
        userId: reminder.createdBy.id,
        action: 'NOTE_REMINDER_SENT',
        resourceType: 'NoteReminder',
        resourceId: reminder.id,
        outcome: 'SUCCESS',
      });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'Reminder delivery failed.';
      await this.prisma.noteReminder.update({
        where: { id: reminder.id },
        data: {
          status: 'FAILED',
          lastAttemptAt: new Date(),
          attemptCount: { increment: 1 },
          lastError: reason,
        },
      });
      await this.auditService.logEvent({
        businessId: reminder.businessId,
        userId: reminder.createdBy.id,
        action: 'NOTE_REMINDER_FAILED',
        resourceType: 'NoteReminder',
        resourceId: reminder.id,
        outcome: 'FAILURE',
        reason,
      });
    }
  }

  private async markCancelled(reminderId: string, reason: string) {
    await this.prisma.noteReminder.update({
      where: { id: reminderId },
      data: { status: 'CANCELLED', lastError: reason },
    });
  }
}
