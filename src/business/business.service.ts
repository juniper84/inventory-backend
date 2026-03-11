import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { SubscriptionTier } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionService } from '../subscription/subscription.service';
import {
  ADMIN_FORBIDDEN_PERMISSIONS,
  CASHIER_PERMISSIONS,
  EMPLOYEE_PERMISSIONS,
  MANAGER_PERMISSIONS,
  PermissionsList,
} from '../rbac/permissions';
import { verifyPassword } from '../auth/password';
import {
  DEFAULT_APPROVAL_DEFAULTS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_LOCALE_SETTINGS,
  DEFAULT_POS_POLICIES,
  DEFAULT_STOCK_POLICIES,
  DEFAULT_ONBOARDING,
} from '../settings/defaults';

@Injectable()
export class BusinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  getBusiness(businessId: string) {
    return this.prisma.business.findUnique({ where: { id: businessId } });
  }

  async createBusiness(data: {
    name: string;
    defaultLanguage?: string;
    tier?: SubscriptionTier;
    actorId?: string;
  }) {
    // seedPermissions is idempotent (skipDuplicates: true) — safe outside the transaction
    await this.seedPermissions();

    // Wrap all core business creation writes in a single atomic transaction so
    // that a failure at any step leaves no orphaned partial records
    const { business, branch, roleMap } = await this.prisma.$transaction(
      async (tx) => {
        const business = await tx.business.create({
          data: {
            name: data.name,
            defaultLanguage: data.defaultLanguage ?? 'en',
            status: 'TRIAL',
          },
        });

        const branch = await tx.branch.create({
          data: {
            businessId: business.id,
            name: 'Main Branch',
            isDefault: true,
          },
        });

        await tx.businessSettings.create({
          data: {
            businessId: business.id,
            approvalDefaults: DEFAULT_APPROVAL_DEFAULTS,
            notificationDefaults: DEFAULT_NOTIFICATION_SETTINGS,
            stockPolicies: DEFAULT_STOCK_POLICIES,
            posPolicies: DEFAULT_POS_POLICIES,
            localeSettings: DEFAULT_LOCALE_SETTINGS,
            onboarding: DEFAULT_ONBOARDING,
          },
        });

        // Inline seedDefaultRoles using the tx client
        const systemRoles: Array<{ name: string; approvalTier: number }> = [
          { name: 'System Owner', approvalTier: 3 },
          { name: 'Admin', approvalTier: 2 },
          { name: 'Manager', approvalTier: 1 },
          { name: 'Employee', approvalTier: 0 },
          { name: 'Cashier', approvalTier: 0 },
        ];
        const roles = await Promise.all(
          systemRoles.map(({ name, approvalTier }) =>
            tx.role.create({
              data: { businessId: business.id, name, isSystem: true, approvalTier },
            }),
          ),
        );

        const permissions = await tx.permission.findMany({
          where: { code: { in: Object.values(PermissionsList) } },
        });

        const permissionByCode = new Map(
          permissions.map((perm) => [perm.code, perm.id]),
        );
        const resolveIds = (codes: string[]): string[] =>
          codes.flatMap((code) => {
            const id = permissionByCode.get(code);
            return id ? [id] : [];
          });
        const adminForbidden = new Set<string>(ADMIN_FORBIDDEN_PERMISSIONS);
        const rolePermissionsMap: Record<string, string[]> = {
          'System Owner': permissions.map((perm) => perm.id),
          Admin: permissions
            .filter((perm) => !adminForbidden.has(perm.code))
            .map((perm) => perm.id),
          Manager: resolveIds(MANAGER_PERMISSIONS),
          Employee: resolveIds(EMPLOYEE_PERMISSIONS),
          Cashier: resolveIds(CASHIER_PERMISSIONS),
        };
        await Promise.all(
          roles.map((role) => {
            const permissionIds = rolePermissionsMap[role.name] || [];
            return tx.rolePermission.createMany({
              data: permissionIds.map((permissionId) => ({
                roleId: role.id,
                permissionId,
              })),
              skipDuplicates: true,
            });
          }),
        );
        const roleMap = roles.reduce<Record<string, string>>((acc, role) => {
          acc[role.name] = role.id;
          return acc;
        }, {});

        // Approval policies
        const approvalDefaults = DEFAULT_APPROVAL_DEFAULTS;
        const approvalPolicies = [
          {
            businessId: business.id,
            actionType: 'BARCODE_REASSIGN',
            thresholdType: 'NONE',
            requiredRoleIds: [],
            allowSelfApprove: false,
          },
          {
            businessId: business.id,
            actionType: 'SKU_REASSIGN',
            thresholdType: 'NONE',
            requiredRoleIds: [],
            allowSelfApprove: false,
          },
        ] as Array<{
          businessId: string;
          actionType: string;
          thresholdType: 'NONE' | 'PERCENT' | 'AMOUNT';
          thresholdValue?: number | null;
          requiredRoleIds: string[];
          allowSelfApprove: boolean;
        }>;
        const buildAmountPolicy = (
          actionType: string,
          threshold?: number | null,
        ) =>
          ({
            businessId: business.id,
            actionType,
            thresholdType:
              typeof threshold === 'number' && threshold > 0 ? 'AMOUNT' : 'NONE',
            thresholdValue:
              typeof threshold === 'number' && threshold > 0 ? threshold : null,
            requiredRoleIds: [],
            allowSelfApprove: false,
          }) satisfies (typeof approvalPolicies)[number];

        const discountThresholdPercent =
          approvalDefaults.discountThresholdPercent;
        const discountThresholdAmount = approvalDefaults.discountThresholdAmount;
        if (
          (typeof discountThresholdPercent === 'number' &&
            discountThresholdPercent > 0) ||
          (typeof discountThresholdAmount === 'number' &&
            discountThresholdAmount > 0)
        ) {
          approvalPolicies.push({
            businessId: business.id,
            actionType: 'SALE_DISCOUNT',
            thresholdType:
              typeof discountThresholdPercent === 'number' &&
              discountThresholdPercent > 0
                ? 'PERCENT'
                : 'AMOUNT',
            thresholdValue:
              typeof discountThresholdPercent === 'number' &&
              discountThresholdPercent > 0
                ? discountThresholdPercent
                : (discountThresholdAmount ?? null),
            requiredRoleIds: [],
            allowSelfApprove: false,
          });
        }
        if (approvalDefaults.refund) {
          approvalPolicies.push(
            buildAmountPolicy('SALE_REFUND', approvalDefaults.refundThresholdAmount),
            buildAmountPolicy('RETURN_WITHOUT_RECEIPT', approvalDefaults.refundThresholdAmount),
          );
        }
        if (approvalDefaults.stockAdjust) {
          approvalPolicies.push(
            buildAmountPolicy('STOCK_ADJUSTMENT', approvalDefaults.stockAdjustThresholdAmount),
            buildAmountPolicy('STOCK_COUNT', approvalDefaults.stockAdjustThresholdAmount),
          );
        }
        if (approvalDefaults.transfer) {
          approvalPolicies.push(
            buildAmountPolicy('TRANSFER_APPROVAL', approvalDefaults.transferThresholdAmount),
          );
        }
        if (approvalDefaults.purchase) {
          approvalPolicies.push(
            buildAmountPolicy('PURCHASE_CREATE', approvalDefaults.purchaseThresholdAmount),
            buildAmountPolicy('PURCHASE_ORDER_APPROVAL', approvalDefaults.purchaseThresholdAmount),
            buildAmountPolicy('PURCHASE_ORDER_EDIT', approvalDefaults.purchaseThresholdAmount),
            buildAmountPolicy('SUPPLIER_RETURN', approvalDefaults.purchaseThresholdAmount),
          );
        }
        if (approvalDefaults.expense) {
          approvalPolicies.push(
            buildAmountPolicy('EXPENSE_CREATE', approvalDefaults.expenseThresholdAmount),
          );
        }

        await tx.approvalPolicy.createMany({
          data: approvalPolicies,
          skipDuplicates: true,
        });

        return { business, branch, roleMap };
      },
      { timeout: 15000 },
    );

    // Subscription creation and audit events run after the transaction commits.
    // Residual risk: if createTrialSubscription fails, the business record exists
    // without a subscription — recoverable by a platform admin retry, and a much
    // narrower window than before where all 7+ steps were non-atomic.
    const actorId = data.actorId ?? 'background';
    await this.subscriptionService.createTrialSubscription(
      business.id,
      data.tier ?? SubscriptionTier.BUSINESS,
      actorId,
    );

    await this.auditService.logEvent({
      businessId: business.id,
      userId: actorId,
      action: 'SUBSCRIPTION_TRIAL_START',
      resourceType: 'Subscription',
      resourceId: business.id,
      outcome: 'SUCCESS',
    });

    await this.auditService.logEvent({
      businessId: business.id,
      userId: actorId,
      action: 'BUSINESS_CREATE',
      resourceType: 'Business',
      resourceId: business.id,
      outcome: 'SUCCESS',
      metadata: { branchId: branch.id },
    });

    return { business, branch, roles: roleMap };
  }

  async updateBusiness(
    businessId: string,
    userId: string,
    data: { name?: string; defaultLanguage?: string },
  ) {
    const before = await this.prisma.business.findUnique({
      where: { id: businessId },
    });
    if (!before) {
      throw new NotFoundException('Business not found.');
    }

    const result = await this.prisma.business.update({
      where: { id: businessId },
      data,
    });

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'BUSINESS_UPDATE',
      resourceType: 'Business',
      resourceId: businessId,
      outcome: 'SUCCESS',
      metadata: data,
      before: before as unknown as Record<string, unknown>,
      after: result as unknown as Record<string, unknown>,
    });

    return result;
  }

  async deleteBusinessByOwner(params: {
    businessId: string;
    userId: string;
    password: string;
    confirmBusinessId: string;
    confirmText: string;
  }) {
    const { businessId, userId, password, confirmBusinessId, confirmText } =
      params;
    if (confirmBusinessId !== businessId) {
      throw new BadRequestException('Business ID confirmation does not match.');
    }
    if (confirmText !== 'DELETE') {
      throw new BadRequestException('Confirmation text does not match.');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    const systemOwnerRole = await this.prisma.role.findFirst({
      where: { businessId, name: 'System Owner' },
      select: { id: true },
    });
    if (!systemOwnerRole) {
      throw new ForbiddenException('System Owner role missing.');
    }
    const membership = await this.prisma.userRole.findFirst({
      where: { userId, roleId: systemOwnerRole.id },
    });
    if (!membership) {
      throw new ForbiddenException(
        'Only the System Owner can delete a business.',
      );
    }

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });
    if (!business) {
      throw new BadRequestException('Business not found.');
    }
    if (business.status === 'ARCHIVED' || business.status === 'DELETED') {
      return business;
    }

    // NOTE: GDPR — This only archives the business (sets status to ARCHIVED).
    // Hard deletion of all associated user data is a future requirement to support
    // GDPR "right to erasure" requests. Until implemented, data is soft-deleted
    // and access is blocked via read-only mode.
    const [updated] = await this.prisma.$transaction([
      this.prisma.business.update({
        where: { id: businessId },
        data: { status: 'ARCHIVED' },
      }),
      this.prisma.businessSettings.update({
        where: { businessId },
        data: {
          readOnlyEnabled: true,
          readOnlyReason: 'Business archived by owner.',
          readOnlyEnabledAt: new Date(),
        },
      }),
    ]);

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'BUSINESS_DELETE_REQUEST',
      resourceType: 'Business',
      resourceId: businessId,
      outcome: 'SUCCESS',
      reason: 'Owner requested deletion',
      metadata: { requestedBy: user.email },
      before: business as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });

    const userIds = await this.prisma.businessUser
      .findMany({
        where: { businessId },
        select: { userId: true },
      })
      .then((rows) => rows.map((row) => row.userId));
    if (userIds.length) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: { in: userIds }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'BUSINESS_DELETE',
      resourceType: 'Business',
      resourceId: businessId,
      outcome: 'SUCCESS',
      metadata: { requestedBy: user.email },
      before: business as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'BUSINESS_FORCE_LOGOUT',
      resourceType: 'Business',
      resourceId: businessId,
      outcome: 'SUCCESS',
      metadata: { revokedUsers: userIds.length },
    });

    return updated;
  }

  private async seedPermissions() {
    const codes = Object.values(PermissionsList);
    await this.prisma.permission.createMany({
      data: codes.map((code) => ({ code })),
      skipDuplicates: true,
    });

    // G2-M3: Retroactively assign any newly-seeded permissions to all existing System Owner roles.
    // When new permissions are added to the catalog they must also be granted to OWNER roles
    // that were created before the permission existed.
    const allPermissions = await this.prisma.permission.findMany({
      select: { id: true },
    });
    const ownerRoles = await this.prisma.role.findMany({
      where: { name: 'System Owner', isSystem: true },
      select: { id: true },
    });
    if (ownerRoles.length && allPermissions.length) {
      await this.prisma.rolePermission.createMany({
        data: ownerRoles.flatMap((role) =>
          allPermissions.map((permission) => ({
            roleId: role.id,
            permissionId: permission.id,
          })),
        ),
        skipDuplicates: true,
      });
    }
  }

  private async seedDefaultRoles(businessId: string) {
    const systemRoles: Array<{ name: string; approvalTier: number }> = [
      { name: 'System Owner', approvalTier: 3 },
      { name: 'Admin', approvalTier: 2 },
      { name: 'Manager', approvalTier: 1 },
      { name: 'Employee', approvalTier: 0 },
      { name: 'Cashier', approvalTier: 0 },
    ];

    const roles = await Promise.all(
      systemRoles.map(({ name, approvalTier }) =>
        this.prisma.role.create({
          data: {
            businessId,
            name,
            isSystem: true,
            approvalTier,
          },
        }),
      ),
    );

    const permissions = await this.prisma.permission.findMany({
      where: { code: { in: Object.values(PermissionsList) } },
    });

    const permissionByCode = new Map(
      permissions.map((perm) => [perm.code, perm.id]),
    );

    const resolveIds = (codes: string[]): string[] =>
      codes.flatMap((code) => {
        const id = permissionByCode.get(code);
        return id ? [id] : [];
      });

    const adminForbidden = new Set<string>(ADMIN_FORBIDDEN_PERMISSIONS);

    const rolePermissionsMap: Record<string, string[]> = {
      'System Owner': permissions.map((perm) => perm.id),
      Admin: permissions
        .filter((perm) => !adminForbidden.has(perm.code))
        .map((perm) => perm.id),
      Manager: resolveIds(MANAGER_PERMISSIONS),
      Employee: resolveIds(EMPLOYEE_PERMISSIONS),
      Cashier: resolveIds(CASHIER_PERMISSIONS),
    };

    await Promise.all(
      roles.map((role) => {
        const permissionIds = rolePermissionsMap[role.name] || [];
        return this.prisma.rolePermission.createMany({
          data: permissionIds.map((permissionId) => ({
            roleId: role.id,
            permissionId,
          })),
          skipDuplicates: true,
        });
      }),
    );

    return roles.reduce<Record<string, string>>((acc, role) => {
      acc[role.name] = role.id;
      return acc;
    }, {});
  }
}
