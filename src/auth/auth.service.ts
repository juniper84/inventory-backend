import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from './auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { AuditService } from '../audit/audit.service';
import { hashPassword, validatePassword, verifyPassword } from './password';
import { SupportAccessService } from '../support-access/support-access.service';
import { PermissionsList } from '../rbac/permissions';
import { MailerService } from '../mailer/mailer.service';
import { NotificationsService } from '../notifications/notifications.service';
import { I18nService } from '../i18n/i18n.service';
import { buildBrandedEmail } from '../mailer/email-templates';

const SUPPORT_PERMISSIONS = [
  PermissionsList.BUSINESS_READ,
  PermissionsList.USERS_READ,
  PermissionsList.ROLES_READ,
  PermissionsList.CATALOG_READ,
  PermissionsList.STOCK_READ,
  PermissionsList.TRANSFERS_READ,
  PermissionsList.SALES_READ,
  PermissionsList.PURCHASES_READ,
  PermissionsList.SUPPLIERS_READ,
  PermissionsList.REPORTS_READ,
  PermissionsList.OFFLINE_READ,
  PermissionsList.SETTINGS_READ,
  PermissionsList.NOTIFICATIONS_READ,
];

const SUPPORT_SCOPE_PERMISSIONS: Record<string, string[]> = {
  business: [PermissionsList.BUSINESS_READ],
  users: [PermissionsList.USERS_READ],
  roles: [PermissionsList.ROLES_READ],
  catalog: [PermissionsList.CATALOG_READ],
  stock: [PermissionsList.STOCK_READ],
  transfers: [PermissionsList.TRANSFERS_READ],
  sales: [PermissionsList.SALES_READ],
  purchases: [PermissionsList.PURCHASES_READ],
  suppliers: [PermissionsList.SUPPLIERS_READ],
  reports: [PermissionsList.REPORTS_READ],
  offline: [PermissionsList.OFFLINE_READ],
  settings: [PermissionsList.SETTINGS_READ],
  notifications: [PermissionsList.NOTIFICATIONS_READ],
};

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly rbacService: RbacService,
    private readonly subscriptionService: SubscriptionService,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly supportAccessService: SupportAccessService,
    private readonly mailerService: MailerService,
    private readonly notificationsService: NotificationsService,
    private readonly i18n: I18nService,
  ) {}

  async signIn(
    {
      email,
      password,
      businessId,
      deviceId,
    }: {
      email: string;
      password: string;
      businessId?: string;
      deviceId?: string;
    },
    requestMetadata?: Record<string, unknown>,
  ) {
    if (!deviceId) {
      throw new UnauthorizedException('Device ID required.');
    }
    const user = await this.prisma.user.findFirst({
      where: { email },
    });

    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    if (user.status === 'PENDING' && !user.emailVerifiedAt) {
      throw new UnauthorizedException('Email is not verified.');
    }

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('User is not active.');
    }

    let resolvedBusinessId = businessId;
    if (!resolvedBusinessId) {
      const memberships = await this.prisma.businessUser.findMany({
        where: { userId: user.id, status: 'ACTIVE' },
        include: { business: true },
      });
      const available = memberships
        .filter(
          (membership) =>
            membership.business &&
            !['SUSPENDED', 'DELETED'].includes(membership.business.status),
        )
        .map((membership) => ({
          businessId: membership.businessId,
          businessName: membership.business?.name ?? membership.businessId,
          status: membership.business?.status ?? 'UNKNOWN',
        }));

      if (!available.length) {
        throw new UnauthorizedException('User is not active for any business.');
      }

      if (available.length > 1) {
        return {
          businessSelectionRequired: true,
          businesses: available,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
          },
        };
      }

      resolvedBusinessId = available[0].businessId;
    }

    const membership = await this.prisma.businessUser.findUnique({
      where: {
        businessId_userId: { businessId: resolvedBusinessId, userId: user.id },
      },
    });

    if (!membership || membership.status !== 'ACTIVE') {
      throw new UnauthorizedException('User is not active for this business.');
    }

    const business = await this.prisma.business.findUnique({
      where: { id: resolvedBusinessId },
    });

    if (!business || ['SUSPENDED', 'DELETED'].includes(business.status)) {
      throw new UnauthorizedException('Business is not active.');
    }

    const access = await this.rbacService.resolveUserAccess(
      user.id,
      resolvedBusinessId,
    );
    const subscription =
      await this.subscriptionService.getSubscription(resolvedBusinessId);

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      businessId: resolvedBusinessId,
      deviceId,
      roleIds: access.roleIds,
      permissions: access.permissions,
      branchScope: access.branchScope,
      subscriptionState: subscription?.status ?? 'UNKNOWN',
      scope: 'business',
    };

    const accessToken = await this.jwtService.signAsync(payload);
    const refreshToken = await this.issueRefreshToken(user.id, deviceId);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        lastLoginIp: requestMetadata?.ip as string | undefined,
        lastLoginUserAgent: requestMetadata?.userAgent as string | undefined,
        lastLoginDeviceId: deviceId,
      },
    });

    await this.maybeNotifyUnusualLogin({
      businessId: resolvedBusinessId,
      userId: user.id,
      deviceId,
      previousIp: user.lastLoginIp ?? undefined,
      previousUserAgent: user.lastLoginUserAgent ?? undefined,
      previousDeviceId: user.lastLoginDeviceId ?? undefined,
      currentMetadata: requestMetadata,
    });

    await this.auditService.logEvent({
      businessId: resolvedBusinessId,
      userId: user.id,
      action: 'AUTH_LOGIN',
      resourceType: 'User',
      resourceId: user.id,
      outcome: 'SUCCESS',
      metadata: requestMetadata,
    });

    return {
      accessToken,
      refreshToken,
      businessId: resolvedBusinessId,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        mustResetPassword: user.mustResetPassword,
      },
      subscription,
    };
  }

  async refreshToken(
    userId: string,
    refreshToken: string,
    businessId: string,
    deviceId?: string,
    requestMetadata?: Record<string, unknown>,
  ) {
    const tokenHash = this.hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findFirst({
      where: { userId, tokenHash },
    });

    if (!stored || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token expired.');
    }

    if (stored.revokedAt) {
      await this.revokeAllRefreshTokens(
        userId,
        businessId,
        stored.deviceId ?? undefined,
      );
      await this.auditService.logEvent({
        businessId,
        userId,
        action: 'AUTH_REFRESH_REUSE',
        resourceType: 'RefreshToken',
        resourceId: stored.id,
        outcome: 'FAILURE',
        reason: 'Refresh token reuse detected',
        metadata: requestMetadata,
      });
      await this.notificationsService.notifyEvent({
        businessId,
        eventKey: 'securityRefreshTokenReuse',
        actorUserId: userId,
        title: 'Security alert: refresh token reuse',
        message:
          'We detected a reused refresh token and revoked all active sessions. Please sign in again.',
        priority: 'SECURITY',
        metadata: requestMetadata,
      });
      throw new UnauthorizedException('Refresh token reuse detected.');
    }

    if (stored.deviceId && stored.deviceId !== deviceId) {
      throw new UnauthorizedException('Refresh token device mismatch.');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('User not found.');
    }

    const membership = await this.prisma.businessUser.findUnique({
      where: { businessId_userId: { businessId, userId: user.id } },
    });

    if (!membership || membership.status !== 'ACTIVE') {
      throw new UnauthorizedException('User is not active for this business.');
    }

    const access = await this.rbacService.resolveUserAccess(
      user.id,
      businessId,
    );
    const subscription =
      await this.subscriptionService.getSubscription(businessId);

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      businessId,
      deviceId,
      roleIds: access.roleIds,
      permissions: access.permissions,
      branchScope: access.branchScope,
      subscriptionState: subscription?.status ?? 'UNKNOWN',
      scope: 'business',
    };

    const accessToken = await this.jwtService.signAsync(payload);
    const newRefreshToken = await this.issueRefreshToken(user.id, deviceId);

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: {
        revokedAt: new Date(),
        replacedBy: this.hashToken(newRefreshToken),
      },
    });

    await this.auditService.logEvent({
      businessId,
      userId: user.id,
      action: 'AUTH_REFRESH',
      resourceType: 'User',
      resourceId: user.id,
      outcome: 'SUCCESS',
      metadata: requestMetadata,
    });

    return { accessToken, refreshToken: newRefreshToken };
  }

  async logout(
    userId: string,
    refreshToken: string,
    businessId?: string,
    requestMetadata?: Record<string, unknown>,
  ) {
    const tokenHash = this.hashToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { userId, tokenHash },
      data: { revokedAt: new Date() },
    });

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user) {
      await this.auditService.logEvent({
        businessId: businessId ?? 'unknown',
        userId: user.id,
        action: 'AUTH_LOGOUT',
        resourceType: 'User',
        resourceId: user.id,
        outcome: 'SUCCESS',
        metadata: requestMetadata,
      });
    }
  }

  async requestPasswordReset(email: string, businessId: string) {
    const user = await this.prisma.user.findFirst({
      where: { email },
    });

    if (!user) {
      return;
    }

    const membership = await this.prisma.businessUser.findUnique({
      where: { businessId_userId: { businessId, userId: user.id } },
    });

    if (!membership) {
      return;
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 2);

    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    await this.auditService.logEvent({
      businessId,
      userId: user.id,
      action: 'PASSWORD_RESET_REQUEST',
      resourceType: 'User',
      resourceId: user.id,
      outcome: 'SUCCESS',
    });

    const locale: 'en' = 'en';
    const appBaseUrl = this.configService.get<string>('appBaseUrl') || '';
    const resetUrl = appBaseUrl
      ? `${appBaseUrl}/${locale}/password-reset/confirm?token=${encodeURIComponent(
          token,
        )}&userId=${encodeURIComponent(user.id)}`
      : undefined;
    const emailPayload = buildBrandedEmail({
      subject: this.i18n.t(locale, 'email.passwordReset.subject'),
      title: this.i18n.t(locale, 'email.passwordReset.title'),
      body: this.i18n.t(locale, 'email.passwordReset.body', {
        token,
        userId: user.id,
      }),
      ctaLabel: resetUrl
        ? this.i18n.t(locale, 'email.passwordReset.cta')
        : undefined,
      ctaUrl: resetUrl,
      brandName: this.i18n.t(locale, 'email.common.brandName'),
      supportLine: this.i18n.t(locale, 'email.common.supportLine'),
      securityLine: this.i18n.t(locale, 'email.common.securityLine'),
      footerLine: this.i18n.t(locale, 'email.common.footerLine', {
        year: new Date().getFullYear(),
      }),
      preheader: this.i18n.t(locale, 'email.passwordReset.title'),
    });
    await this.mailerService.sendEmail({
      to: user.email,
      ...emailPayload,
    });

    return { token, userId: user.id };
  }

  async requestPasswordResetByEmail(email: string, businessId?: string) {
    const user = await this.prisma.user.findFirst({
      where: { email },
    });
    if (!user) {
      return { requested: true };
    }

    if (businessId) {
      await this.requestPasswordReset(email, businessId);
      return { requested: true };
    }

    const memberships = await this.prisma.businessUser.findMany({
      where: { userId: user.id, status: 'ACTIVE' },
      include: {
        business: {
          select: { id: true, name: true, status: true },
        },
      },
    });

    const available = memberships
      .filter(
        (membership) =>
          membership.business &&
          !['SUSPENDED', 'DELETED'].includes(membership.business.status),
      )
      .map((membership) => ({
        businessId: membership.businessId,
        businessName: membership.business?.name ?? membership.businessId,
      }));

    if (available.length === 1) {
      await this.requestPasswordReset(email, available[0].businessId);
      return { requested: true };
    }

    if (available.length > 1) {
      return {
        businessSelectionRequired: true,
        businesses: available,
      };
    }

    return { requested: true };
  }

  async requestEmailVerification(userId: string, businessId?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return null;
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    await this.prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    await this.auditService.logEvent({
      businessId: businessId ?? 'unknown',
      userId: user.id,
      action: 'EMAIL_VERIFICATION_REQUEST',
      resourceType: 'User',
      resourceId: user.id,
      outcome: 'SUCCESS',
    });

    const locale: 'en' = 'en';
    const appBaseUrl = this.configService.get<string>('appBaseUrl') || '';
    const verifyParams = new URLSearchParams({ token });
    if (businessId) {
      verifyParams.set('businessId', businessId);
    }
    if (user.email) {
      verifyParams.set('email', user.email);
    }
    const verifyUrl = appBaseUrl
      ? `${appBaseUrl}/${locale}/verify-email?${verifyParams.toString()}`
      : undefined;
    const verifyEmailPayload = buildBrandedEmail({
      subject: this.i18n.t(locale, 'email.verifyEmail.subject'),
      title: this.i18n.t(locale, 'email.verifyEmail.title'),
      body: this.i18n.t(locale, 'email.verifyEmail.body', { token }),
      ctaLabel: verifyUrl
        ? this.i18n.t(locale, 'email.verifyEmail.cta')
        : undefined,
      ctaUrl: verifyUrl,
      brandName: this.i18n.t(locale, 'email.common.brandName'),
      supportLine: this.i18n.t(locale, 'email.common.supportLine'),
      securityLine: this.i18n.t(locale, 'email.common.securityLine'),
      footerLine: this.i18n.t(locale, 'email.common.footerLine', {
        year: new Date().getFullYear(),
      }),
      preheader: this.i18n.t(locale, 'email.verifyEmail.title'),
    });
    await this.mailerService.sendEmail({
      to: user.email,
      ...verifyEmailPayload,
    });

    return { token };
  }

  async requestEmailVerificationByEmail(email: string, businessId: string) {
    const user = await this.prisma.user.findFirst({
      where: { email },
    });
    if (!user) {
      return;
    }
    const membership = await this.prisma.businessUser.findUnique({
      where: { businessId_userId: { businessId, userId: user.id } },
    });
    if (!membership) {
      return;
    }
    return this.requestEmailVerification(user.id, businessId);
  }

  async confirmEmailVerification(
    token: string,
    deviceId?: string,
    businessId?: string,
  ) {
    const tokenHash = this.hashToken(token);
    const stored = await this.prisma.emailVerificationToken.findFirst({
      where: { tokenHash, usedAt: null },
    });

    if (!stored || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Verification token expired.');
    }

    await this.prisma.emailVerificationToken.update({
      where: { id: stored.id },
      data: { usedAt: new Date() },
    });

    const user = await this.prisma.user.update({
      where: { id: stored.userId },
      data: { emailVerifiedAt: new Date(), status: 'ACTIVE' },
    });

    await this.prisma.businessUser.updateMany({
      where: { userId: user.id, status: 'PENDING' },
      data: { status: 'ACTIVE' },
    });

    const memberships = await this.prisma.businessUser.findMany({
      where: { userId: user.id },
    });
    if (memberships.length === 0) {
      await this.auditService.logEvent({
        businessId: 'unknown',
        userId: user.id,
        action: 'EMAIL_VERIFICATION_CONFIRM',
        resourceType: 'User',
        resourceId: user.id,
        outcome: 'SUCCESS',
      });
    } else {
      await Promise.all(
        memberships.map((membership) =>
          this.auditService.logEvent({
            businessId: membership.businessId,
            userId: user.id,
            action: 'EMAIL_VERIFICATION_CONFIRM',
            resourceType: 'User',
            resourceId: user.id,
            outcome: 'SUCCESS',
          }),
        ),
      );
    }

    if (!deviceId) {
      return { verified: true };
    }

    const activeMemberships = await this.prisma.businessUser.findMany({
      where: { userId: user.id, status: 'ACTIVE' },
      include: {
        business: { select: { id: true, name: true, status: true } },
      },
    });
    const available = activeMemberships
      .filter(
        (membership) =>
          membership.business &&
          !['SUSPENDED', 'DELETED'].includes(membership.business.status),
      )
      .map((membership) => ({
        businessId: membership.businessId,
        businessName: membership.business?.name ?? membership.businessId,
      }));

    const resolvedBusinessId = businessId
      ? available.find((entry) => entry.businessId === businessId)?.businessId
      : available.length === 1
        ? available[0].businessId
        : null;

    if (!resolvedBusinessId) {
      return {
        verified: true,
        businessSelectionRequired: available.length > 1,
        businesses: available,
      };
    }

    const session = await this.switchBusinessForUser({
      userId: user.id,
      businessId: resolvedBusinessId,
      deviceId,
      metadata: { source: 'email-verification' },
    });

    return {
      verified: true,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      businessId: resolvedBusinessId,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        mustResetPassword: user.mustResetPassword,
      },
    };
  }

  async resetPassword(token: string, newPassword: string, userId?: string) {
    if (!validatePassword(newPassword)) {
      throw new UnauthorizedException('Password does not meet requirements.');
    }
    const tokenHash = this.hashToken(token);
    const stored = await this.prisma.passwordResetToken.findFirst({
      where: {
        tokenHash,
        usedAt: null,
        ...(userId ? { userId } : {}),
      },
    });

    if (!stored || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Reset token expired.');
    }

    await this.prisma.passwordResetToken.update({
      where: { id: stored.id },
      data: { usedAt: new Date() },
    });

    await this.prisma.user.update({
      where: { id: stored.userId },
      data: {
        passwordHash: hashPassword(newPassword),
        mustResetPassword: false,
        passwordUpdatedAt: new Date(),
      },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: stored.userId },
    });
    if (user) {
      await this.auditService.logEvent({
        businessId: 'unknown',
        userId: user.id,
        action: 'PASSWORD_RESET_CONFIRM',
        resourceType: 'User',
        resourceId: user.id,
        outcome: 'SUCCESS',
      });
    }
  }

  async setPassword(userId: string, password: string) {
    if (!validatePassword(password)) {
      throw new UnauthorizedException('Password does not meet requirements.');
    }
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: hashPassword(password),
        mustResetPassword: false,
        passwordUpdatedAt: new Date(),
      },
    });
  }

  async switchBusiness({
    email,
    password,
    businessId,
    deviceId,
    metadata,
  }: {
    email: string;
    password: string;
    businessId: string;
    deviceId?: string;
    metadata?: Record<string, unknown>;
  }) {
    return this.signIn({ email, password, businessId, deviceId }, metadata);
  }

  async switchBusinessForUser(data: {
    userId: string;
    businessId: string;
    deviceId?: string;
    metadata?: Record<string, unknown>;
  }) {
    if (!data.deviceId) {
      throw new UnauthorizedException('Device ID required.');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: data.userId },
    });
    if (!user) {
      throw new UnauthorizedException('User not found.');
    }

    const membership = await this.prisma.businessUser.findUnique({
      where: {
        businessId_userId: { businessId: data.businessId, userId: user.id },
      },
    });

    if (!membership || membership.status !== 'ACTIVE') {
      throw new UnauthorizedException('User is not active for this business.');
    }

    const access = await this.rbacService.resolveUserAccess(
      user.id,
      data.businessId,
    );
    const subscription = await this.subscriptionService.getSubscription(
      data.businessId,
    );

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      businessId: data.businessId,
      deviceId: data.deviceId,
      roleIds: access.roleIds,
      permissions: access.permissions,
      branchScope: access.branchScope,
      subscriptionState: subscription?.status ?? 'UNKNOWN',
      scope: 'business',
    };

    const accessToken = await this.jwtService.signAsync(payload);
    const refreshToken = await this.issueRefreshToken(user.id, data.deviceId);

    await this.auditService.logEvent({
      businessId: data.businessId,
      userId: user.id,
      action: 'AUTH_SWITCH_BUSINESS',
      resourceType: 'User',
      resourceId: user.id,
      outcome: 'SUCCESS',
      metadata: data.metadata,
    });

    return { accessToken, refreshToken };
  }

  async listUserBusinesses(userId: string) {
    if (!userId) {
      return [];
    }
    const memberships = await this.prisma.businessUser.findMany({
      where: { userId },
      include: {
        business: {
          select: { id: true, name: true, status: true, defaultLanguage: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return memberships.map((membership) => ({
      businessId: membership.businessId,
      businessName: membership.business.name,
      status: membership.status,
      businessStatus: membership.business.status,
      defaultLanguage: membership.business.defaultLanguage,
    }));
  }

  async createPlatformAdmin(email: string, password: string) {
    const existing = await this.prisma.platformAdmin.findUnique({
      where: { email },
    });
    if (existing) {
      return existing;
    }

    return this.prisma.platformAdmin.create({
      data: {
        email,
        passwordHash: hashPassword(password),
      },
    });
  }

  async signInPlatformAdmin(email: string, password: string) {
    const admin = await this.prisma.platformAdmin.findUnique({
      where: { email },
    });

    if (!admin || !verifyPassword(password, admin.passwordHash)) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    if (admin.status !== 'ACTIVE') {
      throw new UnauthorizedException('Admin is not active.');
    }

    const payload: JwtPayload = {
      sub: admin.id,
      email: admin.email,
      businessId: 'platform',
      roleIds: [],
      permissions: [],
      branchScope: [],
      subscriptionState: 'ACTIVE',
      scope: 'platform',
    };

    await this.prisma.platformAdmin.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    const accessToken = await this.jwtService.signAsync(payload);
    return { accessToken };
  }

  async signInSupportAccess(token: string) {
    const session = await this.supportAccessService.validateSession(token);
    if (!session) {
      throw new UnauthorizedException('Invalid support access token.');
    }

    const scopeList = Array.isArray(session.scope)
      ? session.scope.filter((item) => typeof item === 'string')
      : [];
    const scopedPermissions = scopeList.length
      ? Array.from(
          new Set(
            scopeList.flatMap((key) => SUPPORT_SCOPE_PERMISSIONS[key] ?? []),
          ),
        )
      : SUPPORT_PERMISSIONS;

    const payload: JwtPayload = {
      sub: session.platformAdminId,
      email: 'support-access',
      businessId: session.businessId,
      roleIds: [],
      permissions: scopedPermissions,
      branchScope: [],
      subscriptionState: 'ACTIVE',
      scope: 'support',
      supportScope: scopeList.length ? scopeList : undefined,
    };

    const accessToken = await this.jwtService.signAsync(payload);
    return {
      accessToken,
      businessId: session.businessId,
      expiresAt: session.expiresAt,
    };
  }

  private async issueRefreshToken(userId: string, deviceId?: string) {
    const token = crypto.randomBytes(48).toString('hex');
    const tokenHash = this.hashToken(token);
    const expiresInDays = parseInt(
      this.configService.get<string>('jwt.refreshDays') ?? '30',
      10,
    );
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);

    await this.prisma.refreshToken.create({
      data: {
        userId,
        deviceId: deviceId ?? null,
        tokenHash,
        expiresAt,
      },
    });

    return token;
  }

  private hashToken(token: string) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private async revokeAllRefreshTokens(
    userId: string,
    businessId?: string,
    deviceId?: string,
  ) {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.auditService.logEvent({
      businessId: businessId ?? 'unknown',
      userId,
      action: 'AUTH_REVOKE_ALL_SESSIONS',
      resourceType: 'RefreshToken',
      outcome: 'SUCCESS',
      metadata: deviceId ? { deviceId } : undefined,
    });
  }

  private async maybeNotifyUnusualLogin(data: {
    businessId: string;
    userId: string;
    deviceId?: string;
    previousIp?: string;
    previousUserAgent?: string;
    previousDeviceId?: string;
    currentMetadata?: Record<string, unknown>;
  }) {
    const currentIp = data.currentMetadata?.ip as string | undefined;
    const currentUserAgent = data.currentMetadata?.userAgent as
      | string
      | undefined;

    const newDevice =
      !!data.previousDeviceId &&
      !!data.deviceId &&
      data.previousDeviceId !== data.deviceId;
    const newIp =
      !!data.previousIp && !!currentIp && data.previousIp !== currentIp;

    if (!newDevice && !newIp) {
      return;
    }

    const changes = [
      newDevice ? 'new device' : null,
      newIp ? 'new IP' : null,
    ].filter(Boolean);

    await this.notificationsService.notifyEvent({
      businessId: data.businessId,
      eventKey: 'securityUnusualLogin',
      actorUserId: data.userId,
      title: 'Security alert: unusual login',
      message: `We detected a login from a ${changes.join(
        ' and ',
      )}. If this wasn't you, reset your password.`,
      priority: 'SECURITY',
      metadata: {
        previousIp: data.previousIp,
        currentIp,
        previousUserAgent: data.previousUserAgent,
        currentUserAgent,
        previousDeviceId: data.previousDeviceId,
        currentDeviceId: data.deviceId,
      },
    });

    await this.auditService.logEvent({
      businessId: data.businessId,
      userId: data.userId,
      action: 'AUTH_LOGIN_ALERT',
      resourceType: 'User',
      resourceId: data.userId,
      outcome: 'SUCCESS',
      metadata: {
        previousIp: data.previousIp,
        currentIp,
        previousDeviceId: data.previousDeviceId,
        currentDeviceId: data.deviceId,
      },
    });
  }
}
