import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SubscriptionTier } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { PermissionsList } from '../rbac/permissions';
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
  }) {
    const business = await this.prisma.business.create({
      data: {
        name: data.name,
        defaultLanguage: data.defaultLanguage ?? 'en',
        status: 'TRIAL',
      },
    });

    const branch = await this.prisma.branch.create({
      data: {
        businessId: business.id,
        name: 'Main Branch',
        isDefault: true,
      },
    });

    await this.prisma.businessSettings.create({
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

    await this.seedPermissions();
    const roleMap = await this.seedDefaultRoles(business.id);
    await this.subscriptionService.createTrialSubscription(
      business.id,
      data.tier ?? SubscriptionTier.BUSINESS,
    );

    await this.auditService.logEvent({
      businessId: business.id,
      action: 'SUBSCRIPTION_TRIAL_START',
      resourceType: 'Subscription',
      resourceId: business.id,
      outcome: 'SUCCESS',
    });

    await this.auditService.logEvent({
      businessId: business.id,
      action: 'BUSINESS_CREATE',
      resourceType: 'Business',
      resourceId: business.id,
      outcome: 'SUCCESS',
      metadata: { branchId: branch.id },
    });

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

    const discountThresholdPercent = approvalDefaults.discountThresholdPercent;
    const discountThresholdAmount = approvalDefaults.discountThresholdAmount;
    if (
      (typeof discountThresholdPercent === 'number' &&
        discountThresholdPercent > 0) ||
      (typeof discountThresholdAmount === 'number' && discountThresholdAmount > 0)
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
            : discountThresholdAmount ?? null,
        requiredRoleIds: [],
        allowSelfApprove: false,
      });
    }

    if (approvalDefaults.refund) {
      approvalPolicies.push(
        {
          businessId: business.id,
          actionType: 'SALE_REFUND',
          thresholdType: 'NONE',
          requiredRoleIds: [],
          allowSelfApprove: false,
        },
        {
          businessId: business.id,
          actionType: 'RETURN_WITHOUT_RECEIPT',
          thresholdType: 'NONE',
          requiredRoleIds: [],
          allowSelfApprove: false,
        },
      );
    }

    if (approvalDefaults.stockAdjust) {
      approvalPolicies.push(
        {
          businessId: business.id,
          actionType: 'STOCK_ADJUSTMENT',
          thresholdType: 'NONE',
          requiredRoleIds: [],
          allowSelfApprove: false,
        },
        {
          businessId: business.id,
          actionType: 'STOCK_COUNT',
          thresholdType: 'NONE',
          requiredRoleIds: [],
          allowSelfApprove: false,
        },
      );
    }

    if (approvalDefaults.transfer) {
      approvalPolicies.push({
        businessId: business.id,
        actionType: 'TRANSFER_APPROVAL',
        thresholdType: 'NONE',
        requiredRoleIds: [],
        allowSelfApprove: false,
      });
    }

    if (approvalDefaults.purchase) {
      approvalPolicies.push(
        {
          businessId: business.id,
          actionType: 'PURCHASE_CREATE',
          thresholdType: 'NONE',
          requiredRoleIds: [],
          allowSelfApprove: false,
        },
        {
          businessId: business.id,
          actionType: 'PURCHASE_ORDER_APPROVAL',
          thresholdType: 'NONE',
          requiredRoleIds: [],
          allowSelfApprove: false,
        },
        {
          businessId: business.id,
          actionType: 'PURCHASE_ORDER_EDIT',
          thresholdType: 'NONE',
          requiredRoleIds: [],
          allowSelfApprove: false,
        },
        {
          businessId: business.id,
          actionType: 'SUPPLIER_RETURN',
          thresholdType: 'NONE',
          requiredRoleIds: [],
          allowSelfApprove: false,
        },
      );
    }

    if (approvalDefaults.expense) {
      approvalPolicies.push({
        businessId: business.id,
        actionType: 'EXPENSE_CREATE',
        thresholdType: 'NONE',
        requiredRoleIds: [],
        allowSelfApprove: false,
      });
    }

    await this.prisma.approvalPolicy.createMany({
      data: approvalPolicies,
      skipDuplicates: true,
    });

    return { business, branch, roles: roleMap };
  }

  async updateBusiness(
    businessId: string,
    data: { name?: string; defaultLanguage?: string },
  ) {
    const before = await this.prisma.business.findUnique({
      where: { id: businessId },
    });
    if (!before) {
      return null;
    }

    const result = await this.prisma.business.update({
      where: { id: businessId },
      data,
    });

    await this.auditService.logEvent({
      businessId,
      userId: 'system',
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
  }

  private async seedDefaultRoles(businessId: string) {
    const roleNames = [
      'System Owner',
      'Admin',
      'Manager',
      'Employee',
      'Cashier',
    ];

    const roles = await Promise.all(
      roleNames.map((name) =>
        this.prisma.role.create({
          data: {
            businessId,
            name,
            isSystem: true,
          },
        }),
      ),
    );

    const permissions = await this.prisma.permission.findMany({
      where: { code: { in: Object.values(PermissionsList) } },
    });

    const withoutBusinessDelete = permissions
      .filter((perm) => perm.code !== PermissionsList.BUSINESS_DELETE)
      .map((perm) => perm.id);

    const rolePermissionsMap: Record<string, string[]> = {
      'System Owner': permissions.map((perm) => perm.id),
      Admin: withoutBusinessDelete,
      Manager: permissions
        .filter((perm) =>
          perm.code.match(
            /business|users|roles|catalog|stock|transfers|sales|purchases|suppliers|expenses|reports|exports|attachments|settings|notifications|notes|approvals|audit|subscription|customers|price-lists|shifts|search/,
          ),
        )
        .filter((perm) => perm.code !== PermissionsList.BUSINESS_DELETE)
        .map((perm) => perm.id),
      Employee: permissions
        .filter((perm) =>
          perm.code.match(
            /catalog|stock|sales|reports|notifications|notes|customers|search/,
          ),
        )
        .map((perm) => perm.id),
      Cashier: permissions
        .filter((perm) =>
          perm.code.match(/sales|catalog|notifications|notes|customers|search/),
        )
        .map((perm) => perm.id),
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
