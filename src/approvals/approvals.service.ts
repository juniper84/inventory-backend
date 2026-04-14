import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Inject,
  forwardRef,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  ApprovalStatus,
  ApprovalThresholdType,
  GainReason,
  LossReason,
  Prisma,
  RecordStatus,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { generateReferenceNumber } from '../common/reference-number';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_APPROVAL_DEFAULTS } from '../settings/defaults';
import { StockService } from '../stock/stock.service';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';
import { resolveResourceNames } from '../common/resource-labels';

type ApprovalRequest = {
  businessId: string;
  actionType: string;
  requestedByUserId: string;
  requesterRoleIds?: string[];
  amount?: number | null;
  percent?: number | null;
  reason?: string;
  metadata?: Record<string, unknown>;
  targetType?: string;
  targetId?: string;
};

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    @Optional()
    @Inject(forwardRef(() => StockService))
    private readonly stockService?: StockService,
  ) {}

  private getMetadataRecord(metadata: Prisma.JsonValue | null) {
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : undefined;
  }

  private getBranchIdFromMetadata(metadata?: Record<string, unknown>) {
    const directBranchId =
      metadata && typeof metadata.branchId === 'string'
        ? metadata.branchId
        : null;
    if (directBranchId) {
      return directBranchId;
    }
    const pendingAction =
      metadata && typeof metadata.pendingAction === 'object'
        ? (metadata.pendingAction as Record<string, unknown>)
        : null;
    const payload =
      pendingAction && typeof pendingAction.payload === 'object'
        ? (pendingAction.payload as Record<string, unknown>)
        : null;
    const payloadBranchId =
      payload && typeof payload.branchId === 'string' ? payload.branchId : null;
    return payloadBranchId ?? null;
  }

  /**
   * Returns a numeric approval tier for a user within a business.
   * Reads the approvalTier column directly from each Role record.
   * A user may hold multiple roles; the highest tier wins.
   */
  private async getUserApprovalTier(
    userId: string,
    businessId: string,
  ): Promise<number> {
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId, role: { businessId } },
      select: { role: { select: { approvalTier: true } } },
    });
    let maxTier = 0;
    for (const ur of userRoles) {
      maxTier = Math.max(maxTier, ur.role.approvalTier);
    }
    return maxTier;
  }

  private getPendingAction(metadata: Prisma.JsonValue | null) {
    const record = this.getMetadataRecord(metadata);
    if (!record) {
      return null;
    }
    const pendingAction = record.pendingAction;
    if (!pendingAction || typeof pendingAction !== 'object') {
      return null;
    }
    const type =
      typeof (pendingAction as Record<string, unknown>).type === 'string'
        ? String((pendingAction as Record<string, unknown>).type)
        : null;
    const payload =
      (pendingAction as Record<string, unknown>).payload &&
      typeof (pendingAction as Record<string, unknown>).payload === 'object' &&
      !Array.isArray((pendingAction as Record<string, unknown>).payload)
        ? ((pendingAction as Record<string, unknown>).payload as Record<
            string,
            unknown
          >)
        : null;
    if (!type || !payload) {
      return null;
    }
    return { type, payload };
  }

  private parseStockAdjustmentPayload(payload: Record<string, unknown>) {
    const branchId =
      typeof payload.branchId === 'string' ? payload.branchId : null;
    const variantId =
      typeof payload.variantId === 'string' ? payload.variantId : null;
    const quantity =
      typeof payload.quantity === 'number' ? payload.quantity : null;
    const type = typeof payload.type === 'string' ? payload.type : null;
    const lossReasonValue =
      typeof payload.lossReason === 'string' ? payload.lossReason : null;
    const lossReason =
      lossReasonValue &&
      Object.values(LossReason).includes(lossReasonValue as LossReason)
        ? (lossReasonValue as LossReason)
        : undefined;
    const gainReasonValue =
      typeof payload.gainReason === 'string' ? payload.gainReason : null;
    const gainReason =
      gainReasonValue &&
      Object.values(GainReason).includes(gainReasonValue as GainReason)
        ? (gainReasonValue as GainReason)
        : undefined;
    if (!branchId || !variantId || quantity === null || !type) {
      return null;
    }
    return {
      branchId,
      variantId,
      quantity,
      unitId: typeof payload.unitId === 'string' ? payload.unitId : undefined,
      reason: typeof payload.reason === 'string' ? payload.reason : undefined,
      type: type === 'NEGATIVE' ? 'NEGATIVE' : 'POSITIVE',
      batchId:
        typeof payload.batchId === 'string' ? payload.batchId : undefined,
      lossReason,
      gainReason,
      idempotencyKey:
        typeof payload.idempotencyKey === 'string'
          ? payload.idempotencyKey
          : undefined,
    } as const;
  }

  private parseStockCountPayload(payload: Record<string, unknown>) {
    const branchId =
      typeof payload.branchId === 'string' ? payload.branchId : null;
    const variantId =
      typeof payload.variantId === 'string' ? payload.variantId : null;
    const countedQuantity =
      typeof payload.countedQuantity === 'number'
        ? payload.countedQuantity
        : null;
    if (!branchId || !variantId || countedQuantity === null) {
      return null;
    }
    return {
      branchId,
      variantId,
      countedQuantity,
      unitId: typeof payload.unitId === 'string' ? payload.unitId : undefined,
      reason: typeof payload.reason === 'string' ? payload.reason : undefined,
      batchId:
        typeof payload.batchId === 'string' ? payload.batchId : undefined,
      idempotencyKey:
        typeof payload.idempotencyKey === 'string'
          ? payload.idempotencyKey
          : undefined,
    } as const;
  }

  private getStringMetadata(
    metadata: Record<string, unknown> | undefined,
    key: string,
  ) {
    const value = metadata?.[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private getNumberMetadata(
    metadata: Record<string, unknown> | undefined,
    key: string,
  ) {
    const value = metadata?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private getApprovalActionLabel(actionType: string) {
    switch (actionType) {
      case 'STOCK_ADJUSTMENT':
        return 'Stock adjustment';
      case 'STOCK_COUNT':
        return 'Stock count';
      default:
        return actionType;
    }
  }

  private buildApprovalDetail(
    actionType: string,
    metadata?: Record<string, unknown>,
  ) {
    if (!metadata) {
      return null;
    }
    if (actionType === 'STOCK_ADJUSTMENT') {
      const quantity = this.getNumberMetadata(metadata, 'quantity');
      const unitLabel = this.getStringMetadata(metadata, 'unitLabel');
      const variantName = this.getStringMetadata(metadata, 'variantName');
      const productName = this.getStringMetadata(metadata, 'productName');
      const branchName = this.getStringMetadata(metadata, 'branchName');
      const reason = this.getStringMetadata(metadata, 'reason');
      const lossReason = this.getStringMetadata(metadata, 'lossReason');
      const type = this.getStringMetadata(metadata, 'type');
      const sign = type === 'NEGATIVE' ? '-' : type === 'POSITIVE' ? '+' : '';
      const quantityText =
        quantity !== null
          ? `${sign}${quantity}${unitLabel ? ` ${unitLabel}` : ''}`
          : null;
      const parts: string[] = [];
      const variantLabel =
        productName && variantName
          ? `${productName} - ${variantName}`
          : variantName;
      if (quantityText && variantLabel) {
        parts.push(`${quantityText} for ${variantLabel}`);
      } else if (quantityText) {
        parts.push(quantityText);
      } else if (variantLabel) {
        parts.push(variantLabel);
      }
      if (branchName) {
        parts.push(`at ${branchName}`);
      }
      if (reason) {
        parts.push(`reason: ${reason}`);
      }
      if (lossReason) {
        parts.push(`loss: ${lossReason}`);
      }
      return parts.length ? parts.join(' ') : null;
    }
    if (actionType === 'STOCK_COUNT') {
      const counted = this.getNumberMetadata(metadata, 'countedQuantity');
      const expected = this.getNumberMetadata(metadata, 'expectedQuantity');
      const variance = this.getNumberMetadata(metadata, 'variance');
      const unitLabel = this.getStringMetadata(metadata, 'unitLabel');
      const variantName = this.getStringMetadata(metadata, 'variantName');
      const productName = this.getStringMetadata(metadata, 'productName');
      const branchName = this.getStringMetadata(metadata, 'branchName');
      const countedText =
        counted !== null
          ? `${counted}${unitLabel ? ` ${unitLabel}` : ''}`
          : null;
      const parts: string[] = [];
      if (countedText) {
        parts.push(`counted ${countedText}`);
      }
      const variantLabel =
        productName && variantName
          ? `${productName} - ${variantName}`
          : variantName;
      if (variantLabel) {
        parts.push(`for ${variantLabel}`);
      }
      if (branchName) {
        parts.push(`at ${branchName}`);
      }
      if (expected !== null) {
        parts.push(`expected ${expected}`);
      }
      if (variance !== null) {
        const sign = variance > 0 ? '+' : '';
        parts.push(`variance ${sign}${variance}`);
      }
      return parts.length ? parts.join(' ') : null;
    }
    return null;
  }

  private buildApprovalMessage(
    actionType: string,
    status: 'required' | 'approved' | 'rejected' | 'auto-approved',
    metadata?: Record<string, unknown>,
  ) {
    const detail = this.buildApprovalDetail(actionType, metadata);
    const label = this.getApprovalActionLabel(actionType);
    if (!detail) {
      if (status === 'required') {
        return `${actionType} requires approval before proceeding.`;
      }
      if (status === 'approved') {
        return `${actionType} was approved.`;
      }
      if (status === 'rejected') {
        return `${actionType} was rejected.`;
      }
      return `${actionType} was auto-approved.`;
    }
    if (status === 'required') {
      return `${label} ${detail} requires approval.`;
    }
    if (status === 'approved') {
      return `${label} ${detail} was approved.`;
    }
    if (status === 'rejected') {
      return `${label} ${detail} was rejected.`;
    }
    return `${label} ${detail} was auto-approved.`;
  }

  private async getUserLookup(businessId: string, ids: string[]) {
    if (!ids.length) {
      return new Map<string, { name: string | null; email: string | null }>();
    }
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids }, memberships: { some: { businessId } } },
      select: { id: true, name: true, email: true },
    });
    return new Map(
      users.map((user) => [user.id, { name: user.name, email: user.email }]),
    );
  }

  listPolicies(
    businessId: string,
    query: PaginationQuery & { search?: string; status?: string } = {},
  ) {
    const pagination = parsePagination(query);
    const search = query.search?.trim();
    return this.prisma.approvalPolicy
      .findMany({
        where: {
          businessId,
          ...(query.status ? { status: query.status as RecordStatus } : {}),
          ...(search
            ? {
                actionType: {
                  contains: search,
                  mode: Prisma.QueryMode.insensitive,
                },
              }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        ...pagination,
      })
      .then((items) => buildPaginatedResponse(items, pagination.take));
  }

  async createPolicy(
    businessId: string,
    userId: string,
    data: {
      actionType: string;
      thresholdType?: 'NONE' | 'PERCENT' | 'AMOUNT';
      thresholdValue?: number | null;
      requiredRoleIds?: string[];
      allowSelfApprove?: boolean;
    },
  ) {
    const existingActive = await this.prisma.approvalPolicy.findFirst({
      where: { businessId, actionType: data.actionType, status: RecordStatus.ACTIVE },
    });
    if (existingActive) {
      throw new ConflictException(
        'An active approval policy already exists for this action type.',
      );
    }
    if (data.requiredRoleIds?.length) {
      const validRoles = await this.prisma.role.findMany({
        where: { id: { in: data.requiredRoleIds }, businessId },
        select: { id: true },
      });
      if (validRoles.length !== data.requiredRoleIds.length) {
        throw new BadRequestException(
          'One or more selected roles are invalid for this business.',
        );
      }
    }
    const policy = await this.prisma.approvalPolicy.create({
      data: {
        businessId,
        actionType: data.actionType,
        thresholdType: (data.thresholdType ?? 'NONE') as ApprovalThresholdType,
        thresholdValue:
          data.thresholdValue !== undefined && data.thresholdValue !== null
            ? new Prisma.Decimal(data.thresholdValue)
            : null,
        requiredRoleIds: data.requiredRoleIds ?? [],
        allowSelfApprove: data.allowSelfApprove ?? false,
      },
    });

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'APPROVAL_POLICY_CREATE',
      resourceType: 'ApprovalPolicy',
      resourceId: policy.id,
      outcome: 'SUCCESS',
      metadata: data,
    });

    return policy;
  }

  async requestApproval(request: ApprovalRequest) {
    // System Owner is the final authority — their actions never need approval.
    const requesterTier = await this.getUserApprovalTier(
      request.requestedByUserId,
      request.businessId,
    );
    if (requesterTier >= 3) {
      return { required: false, approval: null };
    }

    const policy = await this.prisma.approvalPolicy.findFirst({
      where: {
        businessId: request.businessId,
        actionType: request.actionType,
        status: RecordStatus.ACTIVE,
      },
    });

    const resolvedPolicy = policy ?? (await this.resolveDefaultPolicy(request));

    if (!resolvedPolicy) {
      return { required: false, approval: null };
    }

    const thresholdValue = resolvedPolicy.thresholdValue
      ? Number(resolvedPolicy.thresholdValue)
      : null;
    let requiresApproval = true;

    if (
      resolvedPolicy.thresholdType === ApprovalThresholdType.PERCENT &&
      request.percent !== null &&
      request.percent !== undefined &&
      thresholdValue !== null
    ) {
      requiresApproval = request.percent >= thresholdValue;
    }

    if (
      resolvedPolicy.thresholdType === ApprovalThresholdType.AMOUNT &&
      request.amount !== null &&
      request.amount !== undefined &&
      thresholdValue !== null
    ) {
      requiresApproval = request.amount >= thresholdValue;
    }

    if (!requiresApproval) {
      return { required: false, approval: null };
    }

    const requiredRoleIds = Array.isArray(resolvedPolicy.requiredRoleIds)
      ? resolvedPolicy.requiredRoleIds
      : [];
    const requesterRoles = request.requesterRoleIds ?? [];
    const canSelfApprove =
      resolvedPolicy.allowSelfApprove &&
      (requiredRoleIds.length === 0 ||
        requesterRoles.some((roleId) => requiredRoleIds.includes(roleId)));

    const approval = await this.prisma.approval.create({
      data: {
        referenceNumber: await generateReferenceNumber(this.prisma, 'approval', request.businessId),
        businessId: request.businessId,
        actionType: request.actionType,
        status: canSelfApprove
          ? ApprovalStatus.APPROVED
          : ApprovalStatus.PENDING,
        requestedByUserId: request.requestedByUserId,
        approvedByUserId: canSelfApprove ? request.requestedByUserId : null,
        decidedAt: canSelfApprove ? new Date() : null,
        amount:
          request.amount !== null && request.amount !== undefined
            ? new Prisma.Decimal(request.amount)
            : null,
        percent:
          request.percent !== null && request.percent !== undefined
            ? new Prisma.Decimal(request.percent)
            : null,
        reason: request.reason ?? null,
        metadata: ({
          ...(request.metadata ?? {}),
          requesterTier,
        } as Prisma.InputJsonValue),
        targetType: request.targetType ?? null,
        targetId: request.targetId ?? null,
      },
    });

    const approvalBranchId = this.getBranchIdFromMetadata(request.metadata);
    await this.auditService.logEvent({
      businessId: request.businessId,
      userId: request.requestedByUserId,
      action: canSelfApprove ? 'APPROVAL_SELF_APPROVE' : 'APPROVAL_REQUEST',
      resourceType: 'Approval',
      resourceId: approval.id,
      outcome: 'SUCCESS',
      reason: request.reason ?? undefined,
      branchId: approvalBranchId ?? undefined,
      metadata: request.metadata,
    });

    const notifyPendingApprovals =
      await this.notificationsService.isEventEnabled(
        request.businessId,
        'pendingApprovals',
      );
    if (notifyPendingApprovals) {
      const pendingMessage = this.buildApprovalMessage(
        request.actionType,
        canSelfApprove ? 'auto-approved' : 'required',
        request.metadata,
      );
      const branchId = this.getBranchIdFromMetadata(request.metadata);
      await this.notificationsService.notifyEvent({
        businessId: request.businessId,
        eventKey: 'pendingApprovals',
        actorUserId: request.requestedByUserId,
        title: canSelfApprove ? 'Approval auto-approved' : 'Approval required',
        message: pendingMessage,
        priority: canSelfApprove ? 'INFO' : 'ACTION_REQUIRED',
        metadata: {
          approvalId: approval.id,
          actionType: request.actionType,
          ...(request.metadata ?? {}),
        },
        branchId: branchId ?? undefined,
      });
    }

    return { required: !canSelfApprove, approval };
  }

  private async resolveDefaultPolicy(request: ApprovalRequest) {
    const settings = await this.prisma.businessSettings.findUnique({
      where: { businessId: request.businessId },
      select: { approvalDefaults: true },
    });
    const defaults =
      (settings?.approvalDefaults as Record<string, unknown> | null) ?? {};
    const approvalDefaults = {
      ...DEFAULT_APPROVAL_DEFAULTS,
      ...defaults,
    } as {
      stockAdjust?: boolean;
      stockAdjustThresholdAmount?: number | null;
      refund?: boolean;
      refundThresholdAmount?: number | null;
      purchase?: boolean;
      purchaseThresholdAmount?: number | null;
      transfer?: boolean;
      transferThresholdAmount?: number | null;
      expense?: boolean;
      expenseThresholdAmount?: number | null;
      discountThresholdPercent?: number | null;
      discountThresholdAmount?: number | null;
    };

    const requireAll = () => ({
      thresholdType: ApprovalThresholdType.NONE,
      thresholdValue: null,
      requiredRoleIds: [] as string[],
      allowSelfApprove: false,
    });

    switch (request.actionType) {
      case 'SALE_DISCOUNT': {
        const percent = approvalDefaults.discountThresholdPercent;
        const amount = approvalDefaults.discountThresholdAmount;
        if (typeof percent === 'number' && percent > 0) {
          return {
            thresholdType: ApprovalThresholdType.PERCENT,
            thresholdValue: new Prisma.Decimal(percent),
            requiredRoleIds: [],
            allowSelfApprove: false,
          };
        }
        if (typeof amount === 'number' && amount > 0) {
          return {
            thresholdType: ApprovalThresholdType.AMOUNT,
            thresholdValue: new Prisma.Decimal(amount),
            requiredRoleIds: [],
            allowSelfApprove: false,
          };
        }
        return null;
      }
      case 'SALE_REFUND':
      case 'RETURN_WITHOUT_RECEIPT':
        if (!approvalDefaults.refund) {
          return null;
        }
        if (
          typeof approvalDefaults.refundThresholdAmount === 'number' &&
          approvalDefaults.refundThresholdAmount > 0
        ) {
          return {
            thresholdType: ApprovalThresholdType.AMOUNT,
            thresholdValue: new Prisma.Decimal(
              approvalDefaults.refundThresholdAmount,
            ),
            requiredRoleIds: [],
            allowSelfApprove: false,
          };
        }
        return requireAll();
      case 'STOCK_ADJUSTMENT':
      case 'STOCK_COUNT':
        if (!approvalDefaults.stockAdjust) {
          return null;
        }
        if (
          typeof approvalDefaults.stockAdjustThresholdAmount === 'number' &&
          approvalDefaults.stockAdjustThresholdAmount > 0
        ) {
          return {
            thresholdType: ApprovalThresholdType.AMOUNT,
            thresholdValue: new Prisma.Decimal(
              approvalDefaults.stockAdjustThresholdAmount,
            ),
            requiredRoleIds: [],
            allowSelfApprove: false,
          };
        }
        return requireAll();
      case 'TRANSFER_APPROVAL':
        if (!approvalDefaults.transfer) {
          return null;
        }
        if (
          typeof approvalDefaults.transferThresholdAmount === 'number' &&
          approvalDefaults.transferThresholdAmount > 0
        ) {
          return {
            thresholdType: ApprovalThresholdType.AMOUNT,
            thresholdValue: new Prisma.Decimal(
              approvalDefaults.transferThresholdAmount,
            ),
            requiredRoleIds: [],
            allowSelfApprove: false,
          };
        }
        return requireAll();
      case 'PURCHASE_CREATE':
      case 'PURCHASE_ORDER_APPROVAL':
      case 'PURCHASE_ORDER_EDIT':
      case 'SUPPLIER_RETURN':
        if (!approvalDefaults.purchase) {
          return null;
        }
        if (
          typeof approvalDefaults.purchaseThresholdAmount === 'number' &&
          approvalDefaults.purchaseThresholdAmount > 0
        ) {
          return {
            thresholdType: ApprovalThresholdType.AMOUNT,
            thresholdValue: new Prisma.Decimal(
              approvalDefaults.purchaseThresholdAmount,
            ),
            requiredRoleIds: [],
            allowSelfApprove: false,
          };
        }
        return requireAll();
      case 'EXPENSE_CREATE':
        if (!approvalDefaults.expense) {
          return null;
        }
        if (
          typeof approvalDefaults.expenseThresholdAmount === 'number' &&
          approvalDefaults.expenseThresholdAmount > 0
        ) {
          return {
            thresholdType: ApprovalThresholdType.AMOUNT,
            thresholdValue: new Prisma.Decimal(
              approvalDefaults.expenseThresholdAmount,
            ),
            requiredRoleIds: [],
            allowSelfApprove: false,
          };
        }
        return requireAll();
      default:
        return null;
    }
  }

  async updatePolicy(
    businessId: string,
    userId: string,
    policyId: string,
    data: {
      thresholdType?: 'NONE' | 'PERCENT' | 'AMOUNT';
      thresholdValue?: number | null;
      requiredRoleIds?: string[];
      allowSelfApprove?: boolean;
    },
  ) {
    const callerTier = await this.getUserApprovalTier(userId, businessId);
    if (callerTier < 3) {
      throw new ForbiddenException(
        'Only the System Owner can modify approval policies.',
      );
    }
    const existing = await this.prisma.approvalPolicy.findFirst({
      where: { id: policyId, businessId },
    });
    if (!existing) {
      return null;
    }
    if (data.requiredRoleIds?.length) {
      const validRoles = await this.prisma.role.findMany({
        where: { id: { in: data.requiredRoleIds }, businessId },
        select: { id: true },
      });
      if (validRoles.length !== data.requiredRoleIds.length) {
        throw new BadRequestException(
          'One or more selected roles are invalid for this business.',
        );
      }
    }

    const existingRoleIds = Array.isArray(existing.requiredRoleIds)
      ? existing.requiredRoleIds
      : [];

    await this.prisma.approvalPolicy.updateMany({
      where: { id: policyId, businessId },
      data: {
        thresholdType: data.thresholdType
          ? (data.thresholdType as ApprovalThresholdType)
          : existing.thresholdType,
        thresholdValue:
          data.thresholdValue !== undefined
            ? data.thresholdValue === null
              ? null
              : new Prisma.Decimal(data.thresholdValue)
            : existing.thresholdValue,
        requiredRoleIds: data.requiredRoleIds ?? existingRoleIds,
        allowSelfApprove: data.allowSelfApprove ?? existing.allowSelfApprove,
      },
    });
    const policy = (await this.prisma.approvalPolicy.findFirst({
      where: { id: policyId, businessId },
    }))!;

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'APPROVAL_POLICY_UPDATE',
      resourceType: 'ApprovalPolicy',
      resourceId: policy.id,
      outcome: 'SUCCESS',
      metadata: data,
      before: existing as Record<string, unknown>,
      after: policy as Record<string, unknown>,
    });

    return policy;
  }

  async archivePolicy(businessId: string, userId: string, policyId: string) {
    const existing = await this.prisma.approvalPolicy.findFirst({
      where: { id: policyId, businessId },
    });
    if (!existing) {
      return null;
    }

    await this.prisma.approvalPolicy.updateMany({
      where: { id: policyId, businessId },
      data: { status: RecordStatus.ARCHIVED },
    });
    const policy = (await this.prisma.approvalPolicy.findFirst({
      where: { id: policyId, businessId },
    }))!;

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'APPROVAL_POLICY_ARCHIVE',
      resourceType: 'ApprovalPolicy',
      resourceId: policy.id,
      outcome: 'SUCCESS',
    });

    return policy;
  }

  async listApprovals(
    businessId: string,
    callerUserId: string,
    query: PaginationQuery & {
      search?: string;
      status?: string;
      actionType?: string;
      from?: string;
      to?: string;
      includeTotal?: string;
    } = {},
  ) {
    const callerTier = await this.getUserApprovalTier(callerUserId, businessId);
    // Find users in this business whose highest tier exceeds the caller's tier.
    // Those users' approval requests should not be visible to the caller.
    const higherTierUserIds = callerTier < 3
      ? await this.prisma.userRole.findMany({
          where: { role: { businessId, approvalTier: { gt: callerTier } } },
          select: { userId: true },
          distinct: ['userId'],
        }).then((rows) => rows.map((r) => r.userId))
      : [];
    const pagination = parsePagination(query);
    const search = query.search?.trim();
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    const status =
      query.status === 'REQUESTED'
        ? ApprovalStatus.PENDING
        : (query.status as ApprovalStatus);
    const where = {
      businessId,
      ...(higherTierUserIds.length
        ? { requestedByUserId: { notIn: higherTierUserIds } }
        : {}),
      ...(status ? { status } : {}),
      ...(query.actionType ? { actionType: query.actionType } : {}),
      ...(search
        ? {
            OR: [
              {
                actionType: {
                  contains: search,
                  mode: Prisma.QueryMode.insensitive,
                },
              },
              {
                reason: {
                  contains: search,
                  mode: Prisma.QueryMode.insensitive,
                },
              },
              {
                targetId: {
                  contains: search,
                  mode: Prisma.QueryMode.insensitive,
                },
              },
            ],
          }
        : {}),
      ...(from || to
        ? {
            requestedAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };
    const includeTotal =
      query.includeTotal === 'true' || query.includeTotal === '1';
    return Promise.all([
      this.prisma.approval.findMany({
        where,
        orderBy: { requestedAt: 'desc' },
        ...pagination,
      }),
      includeTotal
        ? this.prisma.approval.count({ where })
        : Promise.resolve(null),
    ]).then(async ([items, total]) => {
      const requesterIds = items
        .map((item) => item.requestedByUserId)
        .filter((id): id is string => Boolean(id));
      const userLookup = await this.getUserLookup(businessId, requesterIds);
      const targetLookup = await resolveResourceNames(
        this.prisma,
        businessId,
        items.map((item) => ({
          resourceType: item.targetType ?? undefined,
          resourceId: item.targetId ?? undefined,
        })),
      );
      const enriched = items.map((item) => ({
        ...item,
        requestedByName: item.requestedByUserId
          ? (userLookup.get(item.requestedByUserId)?.name ??
            userLookup.get(item.requestedByUserId)?.email ??
            null)
          : null,
        targetName:
          item.targetType && item.targetId
            ? (targetLookup.get(`${item.targetType}:${item.targetId}`) ?? null)
            : null,
      }));
      return buildPaginatedResponse(
        enriched,
        pagination.take,
        typeof total === 'number' ? total : undefined,
      );
    });
  }

  async approve(businessId: string, approvalId: string, userId: string) {
    const approval = await this.prisma.approval.findFirst({
      where: { id: approvalId, businessId },
    });
    if (!approval) {
      throw new NotFoundException('Approval not found.');
    }
    if (approval.status !== ApprovalStatus.PENDING) {
      return approval;
    }

    if (approval.requestedByUserId && approval.requestedByUserId === userId) {
      throw new BadRequestException('You cannot approve your own request.');
    }

    const approverTier = await this.getUserApprovalTier(userId, businessId);
    const meta = this.getMetadataRecord(approval.metadata);
    const requesterTier =
      typeof meta?.requesterTier === 'number' ? meta.requesterTier : 0;
    if (approverTier <= requesterTier) {
      throw new BadRequestException(
        'You can only approve requests from users with a lower role than yours.',
      );
    }

    const pendingAction = this.getPendingAction(approval.metadata);
    if (pendingAction) {
      if (!this.stockService) {
        throw new BadRequestException(
          'Stock service unavailable for approval.',
        );
      }
      const requestedByUserId = approval.requestedByUserId ?? userId;
      if (pendingAction.type === 'STOCK_ADJUSTMENT') {
        const payload = this.parseStockAdjustmentPayload(pendingAction.payload);
        if (!payload) {
          throw new BadRequestException('Invalid stock adjustment payload.');
        }
        const result = await this.stockService.createAdjustment(
          businessId,
          requestedByUserId,
          [],
          payload,
          { skipApproval: true, approvalId },
        );
        if (
          result &&
          typeof result === 'object' &&
          'error' in result &&
          result.error
        ) {
          throw new BadRequestException(String(result.error));
        }
      } else if (pendingAction.type === 'STOCK_COUNT') {
        const payload = this.parseStockCountPayload(pendingAction.payload);
        if (!payload) {
          throw new BadRequestException('Invalid stock count payload.');
        }
        const result = await this.stockService.createStockCount(
          businessId,
          requestedByUserId,
          [],
          payload,
          { skipApproval: true, approvalId },
        );
        if (
          result &&
          typeof result === 'object' &&
          'error' in result &&
          result.error
        ) {
          throw new BadRequestException(String(result.error));
        }
      }
    }

    await this.prisma.approval.updateMany({
      where: { id: approvalId, businessId },
      data: {
        status: ApprovalStatus.APPROVED,
        decidedAt: new Date(),
        approvedByUserId: userId,
      },
    });
    const updated = (await this.prisma.approval.findFirst({
      where: { id: approvalId, businessId },
    }))!;

    const approvalMetadata = this.getMetadataRecord(approval.metadata);
    const approvalBranchId = this.getBranchIdFromMetadata(approvalMetadata);
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'APPROVAL_APPROVE',
      resourceType: 'Approval',
      resourceId: approvalId,
      outcome: 'SUCCESS',
      reason: approval.reason ?? 'Approved',
      branchId: approvalBranchId ?? undefined,
      metadata: approvalMetadata,
    });

    await this.notificationsService.notifyEvent({
      businessId,
      eventKey: 'approvalApproved',
      actorUserId: approval.requestedByUserId,
      title: 'Approval approved',
      message: this.buildApprovalMessage(
        approval.actionType,
        'approved',
        approvalMetadata,
      ),
      priority: 'INFO',
      metadata: { approvalId, ...(approvalMetadata ?? {}) },
      branchId: approvalBranchId ?? undefined,
    });

    return updated;
  }

  async bulkApprove(
    businessId: string,
    approvalIds: string[],
    userId: string,
  ) {
    const results: { id: string; success: boolean; error?: string }[] = [];
    for (const id of approvalIds) {
      try {
        await this.approve(businessId, id, userId);
        results.push({ id, success: true });
      } catch (err) {
        results.push({
          id,
          success: false,
          error: err instanceof Error ? err.message : 'Failed',
        });
      }
    }
    return results;
  }

  async bulkReject(
    businessId: string,
    approvalIds: string[],
    userId: string,
    reason?: string,
  ) {
    const results: { id: string; success: boolean; error?: string }[] = [];
    for (const id of approvalIds) {
      try {
        await this.reject(businessId, id, userId, reason);
        results.push({ id, success: true });
      } catch (err) {
        results.push({
          id,
          success: false,
          error: err instanceof Error ? err.message : 'Failed',
        });
      }
    }
    return results;
  }

  async reject(
    businessId: string,
    approvalId: string,
    userId: string,
    reason?: string,
  ) {
    const approval = await this.prisma.approval.findFirst({
      where: { id: approvalId, businessId },
    });
    if (!approval) {
      throw new NotFoundException('Approval not found.');
    }
    if (approval.status !== ApprovalStatus.PENDING) {
      return approval;
    }

    if (approval.requestedByUserId && approval.requestedByUserId === userId) {
      throw new BadRequestException('You cannot reject your own request.');
    }

    const rejecterTier = await this.getUserApprovalTier(userId, businessId);
    const rejectMeta = this.getMetadataRecord(approval.metadata);
    const requesterTierForReject =
      typeof rejectMeta?.requesterTier === 'number'
        ? rejectMeta.requesterTier
        : 0;
    if (rejecterTier <= requesterTierForReject) {
      throw new BadRequestException(
        'You can only reject requests from users with a lower role than yours.',
      );
    }

    await this.prisma.approval.updateMany({
      where: { id: approvalId, businessId },
      data: {
        status: ApprovalStatus.REJECTED,
        decidedAt: new Date(),
        approvedByUserId: userId,
        reason: reason ?? null,
      },
    });
    const updated = (await this.prisma.approval.findFirst({
      where: { id: approvalId, businessId },
    }))!;

    const approvalMetadata = this.getMetadataRecord(approval.metadata);
    const approvalBranchId = this.getBranchIdFromMetadata(approvalMetadata);
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'APPROVAL_REJECT',
      resourceType: 'Approval',
      resourceId: approvalId,
      outcome: 'SUCCESS',
      reason: reason ?? undefined,
      branchId: approvalBranchId ?? undefined,
      metadata: {
        ...(approvalMetadata ?? {}),
        ...(reason ? { reason } : {}),
      },
    });

    await this.notificationsService.notifyEvent({
      businessId,
      eventKey: 'approvalRejected',
      actorUserId: approval.requestedByUserId,
      title: 'Approval rejected',
      message: this.buildApprovalMessage(
        approval.actionType,
        'rejected',
        approvalMetadata,
      ),
      priority: 'WARNING',
      metadata: { approvalId, ...(approvalMetadata ?? {}) },
      branchId: approvalBranchId ?? undefined,
    });

    return updated;
  }

  async delegate(
    businessId: string,
    approvalId: string,
    userId: string,
    delegateToUserId: string,
  ) {
    const approval = await this.prisma.approval.findFirst({
      where: { id: approvalId, businessId, status: 'PENDING' },
    });
    if (!approval) {
      throw new NotFoundException('Approval not found or not pending.');
    }
    const delegateUser = await this.prisma.businessUser.findFirst({
      where: { businessId, userId: delegateToUserId, status: 'ACTIVE' },
    });
    if (!delegateUser) {
      throw new BadRequestException('Delegate user not found in this business.');
    }
    const updated = await this.prisma.approval.update({
      where: { id: approvalId },
      data: { delegatedToUserId: delegateToUserId },
    });
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'APPROVAL_DELEGATE',
      resourceType: 'Approval',
      resourceId: approvalId,
      outcome: 'SUCCESS',
      metadata: { delegatedToUserId: delegateToUserId },
    });
    return updated;
  }
}
