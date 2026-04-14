import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
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
import { NotificationStreamService } from '../notifications/notification-stream.service';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly subscriptionService: SubscriptionService,
    private readonly mailerService: MailerService,
    private readonly i18n: I18nService,
    private readonly configService: ConfigService,
    private readonly notificationStream: NotificationStreamService,
  ) {}

  private async getUserMaxTier(userId: string, businessId: string): Promise<number> {
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId, role: { businessId } },
      select: { role: { select: { approvalTier: true } } },
    });
    let max = 0;
    for (const ur of userRoles) {
      max = Math.max(max, ur.role.approvalTier);
    }
    return max;
  }

  private normalizeUserNotificationPreferences(
    raw: Record<string, unknown> | null | undefined,
  ) {
    if (raw === undefined) {
      return undefined;
    }
    if (raw === null || typeof raw !== 'object') {
      return null;
    }
    const next = { ...raw } as Record<string, unknown>;
    if (next.locale !== undefined) {
      next.locale = next.locale === 'sw' ? 'sw' : 'en';
    }
    return next;
  }

  async list(
    businessId: string,
    query: PaginationQuery & {
      search?: string;
      status?: string;
      roleId?: string;
    },
  ) {
    const pagination = parsePagination(query);
    const search = query.search?.trim();
    const userFilter: Prisma.UserWhereInput = {
      ...(search
        ? {
            OR: [
              {
                name: { contains: search, mode: Prisma.QueryMode.insensitive },
              },
              {
                email: { contains: search, mode: Prisma.QueryMode.insensitive },
              },
            ],
          }
        : {}),
      ...(query.roleId ? { roles: { some: { roleId: query.roleId } } } : {}),
    };
    const memberships = (await this.prisma.businessUser.findMany({
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
            roles: {
              select: {
                role: { select: { id: true, name: true, approvalTier: true } },
              },
              where: { role: { businessId } },
            },
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
            roles: {
              select: {
                role: { select: { id: true; name: true; approvalTier: true } };
              };
            };
          };
        };
      };
    }>[];
    // Enrich with online status (has active, non-expired refresh token)
    const userIds = memberships.map((m) => m.user.id);
    const activeTokens = userIds.length
      ? await this.prisma.refreshToken.findMany({
          where: { userId: { in: userIds }, revokedAt: null, expiresAt: { gt: new Date() } },
          select: { userId: true },
        })
      : [];
    const onlineSet = new Set(activeTokens.map((t) => t.userId));

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
      isOnline: onlineSet.has(membership.user.id),
      createdAt: membership.user.createdAt,
      updatedAt: membership.user.updatedAt,
      roles: membership.user.roles.map((ur) => ({
        id: ur.role.id,
        name: ur.role.name,
        approvalTier: ur.role.approvalTier,
      })),
    }));
    return buildPaginatedResponse(items, pagination.take);
  }

  async create(
    businessId: string,
    actorId: string,
    data: {
      name: string;
      email: string;
      phone?: string | null;
      status?: string;
      tempPassword?: string;
      mustResetPassword?: boolean;
    },
  ) {
    // Pre-compute password hash outside the transaction (CPU-bound work)
    const passwordHash = hashPassword(
      data.tempPassword ?? crypto.randomBytes(12).toString('hex'),
    );

    const result = await this.prisma.$transaction(async (tx) => {
      return this.createWithTx(tx, businessId, data, passwordHash);
    });

    this.auditService.logEvent({
      businessId,
      userId: actorId,
      action: result.isExistingUser ? 'USER_LINK_BUSINESS' : 'USER_CREATE',
      resourceType: 'User',
      resourceId: result.user.id,
      outcome: 'SUCCESS',
      metadata: data,
    });
    return {
      id: result.user.id,
      name: result.user.name,
      email: result.user.email,
      phone: result.user.phone ?? null,
      status: result.membership.status,
      mustResetPassword: result.user.mustResetPassword,
      createdAt: result.user.createdAt,
      isExistingUser: result.isExistingUser,
    };
  }

  /**
   * Creates (or links) a user inside an existing transaction.
   * If the user already exists and is verified, links them to the business
   * (multi-business signup). Returns `isExistingUser: true` in that case.
   */
  async createWithTx(
    tx: any,
    businessId: string,
    data: {
      name: string;
      email: string;
      phone?: string | null;
      status?: string;
      tempPassword?: string;
      mustResetPassword?: boolean;
    },
    precomputedPasswordHash?: string,
  ) {
    const passwordHash = precomputedPasswordHash ?? hashPassword(
      data.tempPassword ?? crypto.randomBytes(12).toString('hex'),
    );

    await this.subscriptionService.assertLimit(businessId, 'users', 1, tx);

    let user = await tx.user.findFirst({ where: { email: data.email } });

    if (user && user.emailVerifiedAt) {
      // User exists and is verified — this is a multi-business signup.
      // Don't create a new user, just link them to the new business.
      const membership = await tx.businessUser.upsert({
        where: { businessId_userId: { businessId, userId: user.id } },
        create: { businessId, userId: user.id, status: 'ACTIVE' },
        update: { status: 'ACTIVE' },
      });
      return { user, membership, isExistingUser: true };
    }

    if (!user) {
      user = await tx.user.create({
        data: {
          name: data.name,
          email: data.email,
          phone: data.phone ?? null,
          passwordHash,
          mustResetPassword: data.mustResetPassword ?? true,
          status: data.status as any,
        },
      });
    } else {
      // User exists but email not verified — allow re-signup with updated info
      user = await tx.user.update({
        where: { id: user.id },
        data: {
          name: data.name,
          phone: data.phone ?? null,
          passwordHash,
        },
      });
    }

    const membership = await tx.businessUser.upsert({
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

    return { user, membership, isExistingUser: false };
  }

  async update(
    businessId: string,
    userId: string,
    actorId: string,
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
    if (actorId !== userId && data.status) {
      const actorTier = await this.getUserMaxTier(actorId, businessId);
      const targetTier = await this.getUserMaxTier(userId, businessId);
      if (targetTier >= actorTier) {
        throw new ForbiddenException(
          'You can only change the status of users with a lower role than yours.',
        );
      }
    }
    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: {
          name: data.name,
          email: data.email,
          phone: data.phone ?? undefined,
          notificationPreferences:
            data.notificationPreferences === undefined
              ? undefined
              : (this.normalizeUserNotificationPreferences(
                  data.notificationPreferences,
                ) as any),
          // status is intentionally not updated here — it is a global field affecting
          // login across all businesses. Per-business membership status is handled
          // exclusively via businessUser.status below.
        },
      });
      if (data.status) {
        await tx.businessUser.update({
          where: { businessId_userId: { businessId, userId } },
          data: { status: data.status as any },
        });
      }
      return user;
    });
    this.auditService.logEvent({
      businessId,
      userId: actorId,
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

  async deactivate(businessId: string, userId: string, actorId: string) {
    // Prevent self-deactivation (Fix P3-G1-C5)
    if (actorId === userId) {
      throw new ForbiddenException('You cannot deactivate your own account.');
    }
    const actorTier = await this.getUserMaxTier(actorId, businessId);
    const targetTier = await this.getUserMaxTier(userId, businessId);
    if (targetTier >= actorTier) {
      throw new ForbiddenException(
        'You can only deactivate users with a lower role than yours.',
      );
    }
    const membership = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.businessUser.update({
        where: { businessId_userId: { businessId, userId } },
        data: { status: 'DEACTIVATED' },
      });
      // Revoke all refresh tokens for this user so they cannot obtain new
      // access tokens after deactivation.
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return updated;
    });
    // Push the user out of any active SSE session immediately.
    this.notificationStream.emitForceLogout([userId], 'deactivated');
    // Fire-and-forget email — deactivation is already committed.
    void this.sendDeactivationEmail(businessId, userId);
    this.auditService.logEvent({
      businessId,
      userId: actorId,
      action: 'USER_DEACTIVATE',
      resourceType: 'User',
      resourceId: userId,
      outcome: 'SUCCESS',
    });
    return membership;
  }

  private async sendDeactivationEmail(businessId: string, userId: string) {
    try {
      const [user, business] = await Promise.all([
        this.prisma.user.findUnique({
          where: { id: userId },
          select: { email: true, name: true },
        }),
        this.prisma.business.findUnique({
          where: { id: businessId },
          select: { name: true },
        }),
      ]);
      if (!user?.email) return;
      const businessName = business?.name ?? 'your organization';
      const userName = user.name ?? '';
      await this.mailerService.sendEmail({
        to: user.email,
        subject: `Your account on ${businessName} has been deactivated`,
        text: [
          userName ? `Hi ${userName},` : 'Hi,',
          '',
          `Your account on ${businessName} has been deactivated by a system administrator.`,
          '',
          'If you believe this is a mistake, please contact your system owner directly.',
          '',
          'New Vision Inventory',
        ].join('\n'),
      });
    } catch {
      // Non-critical — deactivation is already committed, email failure is silent.
    }
  }

  async invite(
    businessId: string,
    data: { email: string; roleId: string; branchIds?: string[]; name?: string; phone?: string; createdById?: string },
  ) {
    await this.subscriptionService.assertLimit(businessId, 'users');
    const role = await this.prisma.role.findFirst({
      where: { id: data.roleId, businessId },
    });
    if (!role || role.name === 'System Owner') {
      return null;
    }
    if (data.createdById) {
      const inviterTier = await this.getUserMaxTier(data.createdById, businessId);
      if (role.approvalTier >= inviterTier) {
        throw new ForbiddenException(
          'You can only invite users to roles below your own level.',
        );
      }
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
        branchIds: data.branchIds ?? [],
        inviteeName: data.name ?? null,
        inviteePhone: data.phone ?? null,
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
      ctaLabel: inviteUrl ? this.i18n.t(locale, 'email.invite.cta') : undefined,
      ctaUrl: inviteUrl || undefined,
      brandName: this.i18n.t(locale, 'email.common.brandName'),
      supportLine: this.i18n.t(locale, 'email.common.supportLine'),
      securityLine: this.i18n.t(locale, 'email.common.securityLine'),
      footerLine: this.i18n.t(locale, 'email.common.footerLine', {
        year: new Date().getFullYear(),
      }),
      preheader: this.i18n.t(locale, 'email.invite.title'),
    });
    // If email send fails, roll back the invitation so the token is never orphaned (Fix P3-G1-H9)
    try {
      await this.mailerService.sendEmail({
        to: data.email,
        ...invitePayload,
      });
    } catch (emailError) {
      await this.prisma.invitation.delete({ where: { id: invitation.id } });
      throw emailError;
    }

    // Do NOT return the raw token — it was delivered by email only (Fix P3-G8-C2)
    return { id: invitation.id, email: invitation.email, businessId: invitation.businessId };
  }

  async getInviteInfo(token: string) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const invitation = await this.prisma.invitation.findFirst({
      where: { tokenHash, acceptedAt: null },
    });
    if (!invitation || invitation.expiresAt < new Date()) {
      throw new BadRequestException('Invitation token is invalid or has expired.');
    }
    return { email: invitation.email, businessId: invitation.businessId, name: invitation.inviteeName ?? null };
  }

  async acceptInvite(data: { token: string; name: string; password: string; email?: string }) {
    if (!validatePassword(data.password)) {
      throw new BadRequestException('Password does not meet requirements.');
    }
    const tokenHash = crypto
      .createHash('sha256')
      .update(data.token)
      .digest('hex');
    const invitation = await this.prisma.invitation.findFirst({
      where: { tokenHash, acceptedAt: null },
    });

    if (!invitation || invitation.expiresAt < new Date()) {
      throw new BadRequestException('Invitation token is invalid or has expired.');
    }

    // Verify the caller's email matches the invitation email (Fix P3-G1-C3)
    if (data.email && data.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw new BadRequestException('Email does not match the invitation.');
    }

    // Pre-compute password hash outside the transaction (CPU-bound work)
    const passwordHash = hashPassword(data.password);

    const user = await this.prisma.$transaction(async (tx) => {
      await this.subscriptionService.assertLimit(
        invitation.businessId,
        'users',
        1,
        tx,
      );

      const existing = await tx.user.findFirst({
        where: { email: invitation.email },
      });

      if (existing) {
        // User exists — link them to the new business instead of creating a new user
        await tx.businessUser.upsert({
          where: { businessId_userId: { businessId: invitation.businessId, userId: existing.id } },
          create: { businessId: invitation.businessId, userId: existing.id, status: 'ACTIVE' },
          update: { status: 'ACTIVE' },
        });

        // Create role assignments (branch-scoped or global)
        if (invitation.branchIds.length > 0) {
          for (const branchId of invitation.branchIds) {
            await tx.userRole.create({
              data: { userId: existing.id, roleId: invitation.roleId, branchId },
            });
          }
        } else {
          await tx.userRole.create({
            data: { userId: existing.id, roleId: invitation.roleId },
          });
        }

        await tx.invitation.update({
          where: { id: invitation.id },
          data: { acceptedAt: new Date() },
        });

        return {
          id: existing.id,
          name: existing.name,
          email: existing.email,
          status: existing.status,
          mustResetPassword: existing.mustResetPassword,
          createdAt: existing.createdAt,
        };
      }

      const user = await tx.user.create({
        data: {
          name: invitation.inviteeName || data.name,
          email: invitation.email,
          phone: invitation.inviteePhone || null,
          passwordHash,
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

      await tx.businessUser.create({
        data: {
          businessId: invitation.businessId,
          userId: user.id,
          status: 'ACTIVE',
        },
      });

      if (invitation.branchIds.length > 0) {
        // Create branch-scoped roles
        for (const branchId of invitation.branchIds) {
          await tx.userRole.create({
            data: {
              userId: user.id,
              roleId: invitation.roleId,
              branchId,
            },
          });
        }
      } else {
        // Global role (existing behavior — no branch restriction)
        await tx.userRole.create({
          data: {
            userId: user.id,
            roleId: invitation.roleId,
          },
        });
      }

      await tx.invitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      });

      return user;
    });

    if (!user) {
      return null;
    }

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

  async assignRole(userId: string, roleId: string, branchId?: string | null, txClient?: any) {
    const client = txClient || this.prisma;
    return client.userRole.create({
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
      include: {
        role: {
          include: {
            rolePermissions: {
              include: { permission: { select: { code: true } } },
            },
          },
        },
        branch: true,
      },
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
        role: { select: { id: true, name: true, approvalTier: true } },
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

  async getUserActivity(businessId: string, userId: string) {
    const [salesCount, lastAudit] = await Promise.all([
      this.prisma.sale.count({
        where: { businessId, cashierId: userId, status: 'COMPLETED' },
      }),
      this.prisma.auditLog.findFirst({
        where: { businessId, userId },
        orderBy: { createdAt: 'desc' },
        select: { action: true, createdAt: true },
      }),
    ]);
    return {
      salesCount,
      lastAction: lastAudit?.action ?? null,
      lastActionAt: lastAudit?.createdAt ?? null,
    };
  }

  async getLoginHistory(businessId: string, userId: string) {
    return this.prisma.auditLog.findMany({
      where: { businessId, userId, action: 'AUTH_LOGIN' },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { createdAt: true, metadata: true },
    });
  }

  async addUserRole(
    businessId: string,
    userId: string,
    roleId: string,
    actorId: string,
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
    const actorTier = await this.getUserMaxTier(actorId, businessId);
    if (role.approvalTier >= actorTier) {
      throw new ForbiddenException(
        'You can only assign roles below your own level.',
      );
    }
    if (branchId) {
      const branch = await this.prisma.branch.findFirst({
        where: { id: branchId, businessId },
      });
      if (!branch) {
        return null;
      }
    }

    try {
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
        userId: actorId,
        action: 'USER_ROLE_ASSIGN',
        resourceType: 'UserRole',
        resourceId: result.id,
        outcome: 'SUCCESS',
        reason: 'User role assigned',
        metadata: { userId, roleId, branchId: branchId ?? null },
      });
      return result;
    } catch (error) {
      // Idempotency: if concurrent request already created this role assignment, return existing
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.prisma.userRole.findFirst({
          where: { userId, roleId, branchId: branchId ?? null },
          include: { role: true, branch: true },
        });
      }
      throw error;
    }
  }

  async removeUserRole(
    businessId: string,
    userId: string,
    roleId: string,
    actorId: string,
    branchId?: string | null,
  ) {
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, businessId },
    });
    if (!role) {
      return null;
    }
    if (role.name === 'System Owner') {
      return null;
    }
    const actorTier = await this.getUserMaxTier(actorId, businessId);
    if (role.approvalTier >= actorTier) {
      throw new ForbiddenException(
        'You can only remove roles below your own level.',
      );
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
        userId: actorId,
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
