import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  DEFAULT_APPROVAL_DEFAULTS,
  DEFAULT_LOCALE_SETTINGS,
  DEFAULT_POS_POLICIES,
  DEFAULT_STOCK_POLICIES,
  DEFAULT_ONBOARDING,
} from './defaults';
import {
  normalizeNotificationSettings,
  NotificationRecipientConfig,
  NotificationSettings,
} from '../notifications/notification-config';

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  private mergeNotificationDefaults(
    current?: Record<string, unknown> | null,
  ): Prisma.InputJsonValue {
    return normalizeNotificationSettings(
      current ?? undefined,
    ) as Prisma.InputJsonValue;
  }

  private shouldRequirePhones(settings: NotificationSettings) {
    if (!settings.channels.sms && !settings.channels.whatsapp) {
      return false;
    }
    const hasWhatsapp = Object.values(settings.groups).some(
      (group) => group.channels.whatsapp,
    );
    const hasSms = Object.values(settings.groups).some(
      (group) => group.channels.sms,
    );
    const hasEvents = Object.values(settings.events).some((event) => event.enabled);
    return hasEvents && (hasWhatsapp || hasSms);
  }

  private async resolveRecipientUserIds(
    businessId: string,
    recipients: NotificationRecipientConfig,
  ) {
    const roleIds = new Set(recipients.roleIds);
    const extraRoleNames: string[] = [];
    if (recipients.includeOwners) {
      extraRoleNames.push('System Owner');
    }
    if (recipients.includeManagers) {
      extraRoleNames.push('Manager');
    }
    if (extraRoleNames.length) {
      const extraRoles = await this.prisma.role.findMany({
        where: { businessId, name: { in: extraRoleNames } },
        select: { id: true },
      });
      for (const role of extraRoles) {
        roleIds.add(role.id);
      }
    }

    const userIds = new Set(recipients.userIds);

    if (roleIds.size) {
      const assignments = await this.prisma.userRole.findMany({
        where: { roleId: { in: Array.from(roleIds) } },
        select: { userId: true },
      });
      for (const assignment of assignments) {
        userIds.add(assignment.userId);
      }
    }

    return Array.from(userIds);
  }

  private async assertPhoneNumbersAvailable(
    businessId: string,
    notificationDefaults: NotificationSettings,
    previousDefaults?: NotificationSettings | null,
  ) {
    const nextRequires = this.shouldRequirePhones(notificationDefaults);
    const prevRequires = previousDefaults
      ? this.shouldRequirePhones(previousDefaults)
      : false;
    if (!nextRequires || prevRequires) {
      return;
    }
    const whatsappRecipients =
      notificationDefaults.recipients.whatsapp ??
      notificationDefaults.recipients.global;
    const targetUserIds = await this.resolveRecipientUserIds(
      businessId,
      whatsappRecipients,
    );
    if (!targetUserIds.length) {
      return;
    }
    const missingCount = await this.prisma.businessUser.count({
      where: {
        businessId,
        status: 'ACTIVE',
        userId: { in: targetUserIds },
        user: { phone: null },
      },
    });
    if (missingCount > 0) {
      throw new BadRequestException(
        `SMS/WhatsApp require phone numbers. ${missingCount} active user(s) missing phone numbers.`,
      );
    }
  }

  private mergeApprovalDefaults(
    current?: Record<string, unknown> | null,
  ): Prisma.InputJsonValue {
    return {
      ...DEFAULT_APPROVAL_DEFAULTS,
      ...(current ?? {}),
    } as Prisma.InputJsonValue;
  }

  private mergeOnboarding(
    current?: Record<string, unknown> | null,
  ): Prisma.InputJsonValue {
    return {
      ...DEFAULT_ONBOARDING,
      ...(current ?? {}),
    } as Prisma.InputJsonValue;
  }

  async getSettings(businessId: string) {
    const settings = await this.prisma.businessSettings.findUnique({
      where: { businessId },
    });

    if (settings) {
      return {
        ...settings,
        approvalDefaults: this.mergeApprovalDefaults(
          settings.approvalDefaults as Record<string, unknown>,
        ),
        notificationDefaults: this.mergeNotificationDefaults(
          settings.notificationDefaults as Record<string, unknown>,
        ),
        onboarding: settings.onboarding as Record<string, unknown> | null,
      };
    }

    return this.prisma.businessSettings.create({
      data: {
        businessId,
        approvalDefaults: this.mergeApprovalDefaults(),
        notificationDefaults: this.mergeNotificationDefaults(),
        stockPolicies: DEFAULT_STOCK_POLICIES as Prisma.InputJsonValue,
        posPolicies: DEFAULT_POS_POLICIES as Prisma.InputJsonValue,
        localeSettings: DEFAULT_LOCALE_SETTINGS as Prisma.InputJsonValue,
        onboarding: this.mergeOnboarding(),
      },
    });
  }

  async updateSettings(
    businessId: string,
    data: {
      approvalDefaults?: Record<string, unknown>;
      notificationDefaults?: Record<string, unknown>;
      stockPolicies?: Record<string, unknown>;
      posPolicies?: Record<string, unknown>;
      localeSettings?: Record<string, unknown>;
      onboarding?: Record<string, unknown>;
    },
  ) {
    const existing = await this.prisma.businessSettings.findUnique({
      where: { businessId },
    });

    if (!existing) {
      const created = await this.prisma.businessSettings.create({
        data: {
          businessId,
          approvalDefaults: (data.approvalDefaults ??
            DEFAULT_APPROVAL_DEFAULTS) as Prisma.InputJsonValue,
          notificationDefaults: this.mergeNotificationDefaults(
            data.notificationDefaults as Record<string, unknown>,
          ),
          stockPolicies: (data.stockPolicies ??
            DEFAULT_STOCK_POLICIES) as Prisma.InputJsonValue,
          posPolicies: (data.posPolicies ??
            DEFAULT_POS_POLICIES) as Prisma.InputJsonValue,
          localeSettings: (data.localeSettings ??
            DEFAULT_LOCALE_SETTINGS) as Prisma.InputJsonValue,
          onboarding: this.mergeOnboarding(
            data.onboarding as Record<string, unknown>,
          ),
        },
      });
      await this.auditService.logEvent({
        businessId,
        userId: 'system',
        action: 'SETTINGS_CREATE',
        resourceType: 'BusinessSettings',
        resourceId: created.id,
        outcome: 'SUCCESS',
      });
      return created;
    }

    const mergedOnboarding = data.onboarding
      ? this.mergeOnboarding({
          ...(existing.onboarding as Record<string, unknown> | null),
          ...data.onboarding,
        })
      : undefined;
    const onboardingCompletedAt =
      mergedOnboarding &&
      (mergedOnboarding as Record<string, boolean>).businessProfileComplete &&
      (mergedOnboarding as Record<string, boolean>).branchSetupComplete
        ? (existing.onboardingCompletedAt ?? new Date())
        : (existing.onboardingCompletedAt ?? null);

    const nextNotificationDefaults = this.mergeNotificationDefaults(
      (data.notificationDefaults ?? existing.notificationDefaults) as Record<
        string,
        unknown
      >,
    ) as NotificationSettings;
    const previousNotificationDefaults = this.mergeNotificationDefaults(
      existing.notificationDefaults as Record<string, unknown>,
    ) as NotificationSettings;

    await this.assertPhoneNumbersAvailable(
      businessId,
      nextNotificationDefaults,
      previousNotificationDefaults,
    );

    const updated = await this.prisma.businessSettings.update({
      where: { businessId },
      data: {
        approvalDefaults: this.mergeApprovalDefaults(
          (data.approvalDefaults ??
            existing.approvalDefaults ??
            DEFAULT_APPROVAL_DEFAULTS) as Record<string, unknown>,
        ),
        notificationDefaults: nextNotificationDefaults as Prisma.InputJsonValue,
        stockPolicies: (data.stockPolicies ??
          existing.stockPolicies ??
          DEFAULT_STOCK_POLICIES) as Prisma.InputJsonValue,
        posPolicies: (data.posPolicies ??
          existing.posPolicies ??
          DEFAULT_POS_POLICIES) as Prisma.InputJsonValue,
        localeSettings: (data.localeSettings ??
          existing.localeSettings ??
          DEFAULT_LOCALE_SETTINGS) as Prisma.InputJsonValue,
        onboarding: mergedOnboarding ?? undefined,
        onboardingCompletedAt: mergedOnboarding
          ? onboardingCompletedAt
          : undefined,
      },
    });
    await this.auditService.logEvent({
      businessId,
      userId: 'system',
      action: 'SETTINGS_UPDATE',
      resourceType: 'BusinessSettings',
      resourceId: updated.id,
      outcome: 'SUCCESS',
      before: existing as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });
    return updated;
  }
}
