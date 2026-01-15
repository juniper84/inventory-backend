import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import crypto from 'crypto';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, validatePassword } from '../auth/password';
import { SubscriptionService } from '../subscription/subscription.service';
import { MailerService } from '../mailer/mailer.service';
import { I18nService } from '../i18n/i18n.service';
import { buildBrandedEmail } from '../mailer/email-templates';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';
import { Prisma } from '@prisma/client';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly subscriptionService: SubscriptionService,
    private readonly mailerService: MailerService,
    private readonly i18n: I18nService,
    private readonly configService: ConfigService,
  ) {}

  async list(
    businessId: string,
    query: PaginationQuery & { search?: string; status?: string; roleId?: string },
  ) {
    const pagination = parsePagination(query);
    const search = query.search?.trim();
    const userFilter: Prisma.UserWhereInput = {
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { email: { contains: search, mode: Prisma.QueryMode.insensitive } },
            ],
          }
        : {}),
      ...(query.roleId
        ? { roles: { some: { roleId: query.roleId } } }
        : {}),
    };
    const memberships =
      (await this.prisma.businessUser.findMany({
      where: {
        businessId,
        ...(query.status ? { status: query.status as any } : {}),
        ...(search || query.roleId ? { user: userFilter } : {}),
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            notificationPreferences: true,
            mustResetPassword: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      ...pagination,
    })) as Prisma.BusinessUserGetPayload<{
      include: {
        user: {
          select: {
            id: true;
            name: true;
            email: true;
            phone: true;
            notificationPreferences: true;
            mustResetPassword: true;
            createdAt: true;
            updatedAt: true;
          };
        };
      };
    }>[];
    const items = memberships.map((membership) => ({
      id: membership.user.id,
      name: membership.user.name,
      email: membership.user.email,
      phone: membership.user.phone ?? null,
      notificationPreferences:
        (membership.user.notificationPreferences as Record<
          string,
          unknown
        > | null) ?? null,
      status: membership.status,
      mustResetPassword: membership.user.mustResetPassword,
      createdAt: membership.user.createdAt,
      updatedAt: membership.user.updatedAt,
    }));
    return buildPaginatedResponse(items, pagination.take);
  }

  async create(
    businessId: string,
    data: {
      name: string;
      email: string;
      phone?: string | null;
      status?: string;
      tempPassword?: string;
      mustResetPassword?: boolean;
    },
  ) {
    await this.subscriptionService.assertLimit(businessId, 'users');
    let user = await this.prisma.user.findFirst({
      where: { email: data.email },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          name: data.name,
          email: data.email,
          phone: data.phone ?? null,
          passwordHash: hashPassword(
            data.tempPassword ?? crypto.randomBytes(12).toString('hex'),
          ),
          mustResetPassword: data.mustResetPassword ?? true,
          status: data.status as any,
        },
      });
    }

    const membership = await this.prisma.businessUser.upsert({
      where: { businessId_userId: { businessId, userId: user.id } },
      create: {
        businessId,
        userId: user.id,
        status: (data.status as any) ?? 'ACTIVE',
      },
      update: {
        status: (data.status as any) ?? 'ACTIVE',
      },
    });

    this.auditService.logEvent({
      businessId,
      userId: 'system',
      action: 'USER_CREATE',
      resourceType: 'User',
      resourceId: user.id,
      outcome: 'SUCCESS',
      metadata: data,
    });
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone ?? null,
      status: membership.status,
      mustResetPassword: user.mustResetPassword,
      createdAt: user.createdAt,
    };
  }

  async update(
    businessId: string,
    userId: string,
    data: {
      name?: string;
      email?: string;
      phone?: string | null;
      status?: string;
      notificationPreferences?: Record<string, unknown> | null;
    },
  ) {
    const membership = await this.prisma.businessUser.findUnique({
      where: { businessId_userId: { businessId, userId } },
    });
    if (!membership) {
      return null;
    }

    const before = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!before) {
      return null;
    }
    const result = await this.prisma.user.update({
      where: { id: userId },
      data: {
        name: data.name,
        email: data.email,
        phone: data.phone ?? undefined,
        notificationPreferences:
          data.notificationPreferences === undefined
            ? undefined
            : (data.notificationPreferences as any),
        status: data.status as any,
      },
    });

    if (data.status) {
      await this.prisma.businessUser.update({
        where: { businessId_userId: { businessId, userId } },
        data: { status: data.status as any },
      });
    }
    this.auditService.logEvent({
      businessId,
      userId: 'system',
      action: 'USER_UPDATE',
      resourceType: 'User',
      resourceId: userId,
      outcome: 'SUCCESS',
      metadata: data,
      before: before as unknown as Record<string, unknown>,
      after: result as unknown as Record<string, unknown>,
    });
    return result;
  }

  async deactivate(businessId: string, userId: string) {
    const membership = await this.prisma.businessUser.update({
      where: { businessId_userId: { businessId, userId } },
      data: { status: 'DEACTIVATED' },
    });
    this.auditService.logEvent({
      businessId,
      userId: 'system',
      action: 'USER_DEACTIVATE',
      resourceType: 'User',
      resourceId: userId,
      outcome: 'SUCCESS',
    });
    return membership;
  }

  async invite(
    businessId: string,
    data: { email: string; roleId: string; createdById?: string },
  ) {
    await this.subscriptionService.assertLimit(businessId, 'users');
    const role = await this.prisma.role.findFirst({
      where: { id: data.roleId, businessId },
    });
    if (!role || role.name === 'System Owner') {
      return null;
    }
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const invitation = await this.prisma.invitation.create({
      data: {
        businessId,
        email: data.email,
        roleId: data.roleId,
        tokenHash,
        expiresAt,
        createdById: data.createdById ?? null,
      },
    });

    await this.auditService.logEvent({
      businessId,
      userId: data.createdById,
      action: 'INVITATION_CREATE',
      resourceType: 'Invitation',
      resourceId: invitation.id,
      outcome: 'SUCCESS',
    });

    const locale: 'en' = 'en';
    const appBaseUrl = this.configService.get<string>('appBaseUrl') || '';
    const inviteUrl = `${appBaseUrl}/${locale}/invite?token=${token}`;
    const invitePayload = buildBrandedEmail({
      subject: this.i18n.t(locale, 'email.invite.subject'),
      title: this.i18n.t(locale, 'email.invite.title'),
      body: this.i18n.t(locale, 'email.invite.body', {
        token,
        url: inviteUrl,
      }),
      ctaLabel: inviteUrl
        ? this.i18n.t(locale, 'email.invite.cta')
        : undefined,
      ctaUrl: inviteUrl || undefined,
      brandName: this.i18n.t(locale, 'email.common.brandName'),
      supportLine: this.i18n.t(locale, 'email.common.supportLine'),
      securityLine: this.i18n.t(locale, 'email.common.securityLine'),
      footerLine: this.i18n.t(locale, 'email.common.footerLine', {
        year: new Date().getFullYear(),
      }),
      preheader: this.i18n.t(locale, 'email.invite.title'),
    });
    await this.mailerService.sendEmail({
      to: data.email,
      ...invitePayload,
    });

    return { invitation, token };
  }

  async acceptInvite(data: { token: string; name: string; password: string }) {
    if (!validatePassword(data.password)) {
      return null;
    }
    const tokenHash = crypto
      .createHash('sha256')
      .update(data.token)
      .digest('hex');
    const invitation = await this.prisma.invitation.findFirst({
      where: { tokenHash, acceptedAt: null },
    });

    if (!invitation || invitation.expiresAt < new Date()) {
      return null;
    }

    await this.subscriptionService.assertLimit(invitation.businessId, 'users');

    const existing = await this.prisma.user.findFirst({
      where: { email: invitation.email },
    });

    if (existing) {
      return null;
    }

    const user = await this.prisma.user.create({
      data: {
        name: data.name,
        email: invitation.email,
        passwordHash: hashPassword(data.password),
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
      select: {
        id: true,
        name: true,
        email: true,
        status: true,
        mustResetPassword: true,
        createdAt: true,
      },
    });

    await this.prisma.businessUser.create({
      data: {
        businessId: invitation.businessId,
        userId: user.id,
        status: 'ACTIVE',
      },
    });

    await this.prisma.userRole.create({
      data: {
        userId: user.id,
        roleId: invitation.roleId,
      },
    });

    await this.prisma.invitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date() },
    });

    await this.auditService.logEvent({
      businessId: invitation.businessId,
      userId: user.id,
      action: 'INVITATION_ACCEPT',
      resourceType: 'Invitation',
      resourceId: invitation.id,
      outcome: 'SUCCESS',
    });

    return user;
  }

  async assignRole(userId: string, roleId: string, branchId?: string | null) {
    return this.prisma.userRole.create({
      data: {
        userId,
        roleId,
        branchId: branchId ?? null,
      },
    });
  }

  async listUserRoles(businessId: string, userId: string) {
    return this.prisma.userRole.findMany({
      where: {
        userId,
        role: { businessId },
      },
      include: { role: true, branch: true },
    });
  }

  async getProfile(businessId: string, userId: string) {
    if (!businessId || !userId) {
      return null;
    }
    const membership = await this.prisma.businessUser.findUnique({
      where: { businessId_userId: { businessId, userId } },
      select: { status: true, createdAt: true },
    });
    if (!membership) {
      return null;
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        status: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });
    if (!user) {
      return null;
    }
    const roles = await this.prisma.userRole.findMany({
      where: { userId, role: { businessId } },
      select: {
        role: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
      },
    });
    return {
      user,
      membership,
      roles: roles.map((entry) => ({
        role: entry.role,
        branch: entry.branch ?? null,
      })),
    };
  }

  async addUserRole(
    businessId: string,
    userId: string,
    roleId: string,
    branchId?: string | null,
  ) {
    const membership = await this.prisma.businessUser.findUnique({
      where: { businessId_userId: { businessId, userId } },
    });
    if (!membership) {
      return null;
    }
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, businessId },
    });
    if (!role) {
      return null;
    }
    if (role.name === 'System Owner') {
      return null;
    }
    if (branchId) {
      const branch = await this.prisma.branch.findFirst({
        where: { id: branchId, businessId },
      });
      if (!branch) {
        return null;
      }
    }
    const result = await this.prisma.userRole.create({
      data: {
        userId,
        roleId,
        branchId: branchId ?? null,
      },
      include: { role: true, branch: true },
    });
    this.auditService.logEvent({
      businessId,
      userId: 'system',
      action: 'USER_ROLE_ASSIGN',
      resourceType: 'UserRole',
      resourceId: result.id,
      outcome: 'SUCCESS',
      reason: 'User role assigned',
      metadata: { userId, roleId, branchId: branchId ?? null },
    });
    return result;
  }

  async removeUserRole(
    businessId: string,
    userId: string,
    roleId: string,
    branchId?: string | null,
  ) {
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, businessId },
    });
    if (!role) {
      return null;
    }
    const branchValue = branchId ?? null;
    const deleted = await this.prisma.userRole.deleteMany({
      where: {
        userId,
        roleId,
        branchId: branchValue,
      },
    });
    if (deleted.count > 0) {
      this.auditService.logEvent({
        businessId,
        userId: 'system',
        action: 'USER_ROLE_REMOVE',
        resourceType: 'UserRole',
        resourceId: `${userId}:${roleId}:${branchValue ?? 'global'}`,
        outcome: 'SUCCESS',
        reason: 'User role removed',
        metadata: { userId, roleId, branchId: branchValue },
      });
    }
    return deleted;
  }
}
