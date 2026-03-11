import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, ShiftStatus } from '@prisma/client';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_POS_POLICIES } from '../settings/defaults';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';

type PosPolicies = {
  shiftTrackingEnabled?: boolean;
  shiftVarianceThreshold?: number;
};

@Injectable()
export class ShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly approvalsService: ApprovalsService,
  ) {}

  private async getPosPolicies(businessId: string): Promise<PosPolicies> {
    const settings = await this.prisma.businessSettings.findUnique({
      where: { businessId },
    });
    return (settings?.posPolicies ?? DEFAULT_POS_POLICIES) as PosPolicies;
  }

  async list(
    businessId: string,
    query: PaginationQuery & { branchId?: string; status?: string } = {},
    branchScope: string[] = [],
  ) {
    const pagination = parsePagination(query);
    const branchFilter = this.resolveBranchScope(branchScope, query.branchId);
    return this.prisma.shift
      .findMany({
        where: {
          businessId,
          ...branchFilter,
          ...(query.status ? { status: query.status as ShiftStatus } : {}),
        },
        orderBy: { openedAt: 'desc' },
        ...pagination,
      })
      .then((items) => buildPaginatedResponse(items, pagination.take));
  }

  private resolveBranchScope(branchScope: string[], branchId?: string) {
    if (!branchScope.length) {
      return branchId ? { branchId } : {};
    }
    if (branchId) {
      if (!branchScope.includes(branchId)) {
        throw new ForbiddenException('Branch-scoped role restriction.');
      }
      return { branchId };
    }
    return { branchId: { in: branchScope } };
  }

  async getOpenShift(businessId: string, branchId: string) {
    return this.prisma.shift.findFirst({
      where: { businessId, branchId, status: ShiftStatus.OPEN },
      orderBy: { openedAt: 'desc' },
    });
  }

  async openShift(
    businessId: string,
    userId: string,
    data: { branchId: string; openingCash: number; notes?: string },
  ) {
    // NOTE: P4-SW1-L6 — The open-shift check is done inside a $transaction to prevent
    // TOCTOU, but a database-level unique partial index on (branchId, status='OPEN')
    // would provide a stronger guarantee and eliminate the need for the advisory lock.
    // Add a migration: CREATE UNIQUE INDEX ... ON shifts (branchId) WHERE status = 'OPEN'.
    const shift = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.shift.findFirst({
        where: { businessId, branchId: data.branchId, status: ShiftStatus.OPEN },
        orderBy: { openedAt: 'desc' },
      });
      if (existing) {
        return existing;
      }
      return tx.shift.create({
        data: {
          businessId,
          branchId: data.branchId,
          openedById: userId,
          openingCash: new Prisma.Decimal(data.openingCash),
          notes: data.notes ?? null,
        },
      });
    });
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'SHIFT_OPEN',
      resourceType: 'Shift',
      resourceId: shift.id,
      outcome: 'SUCCESS',
    });
    return shift;
  }

  async closeShift(
    businessId: string,
    userId: string,
    roleIds: string[],
    shiftId: string,
    data: { closingCash: number; varianceReason?: string },
  ) {
    if (data.closingCash < 0) {
      throw new BadRequestException('Closing cash amount cannot be negative.');
    }
    const shift = await this.prisma.shift.findFirst({
      where: { id: shiftId, businessId },
    });
    if (!shift) {
      return null;
    }
    if (shift.status !== ShiftStatus.OPEN) {
      return shift;
    }

    const variance = new Prisma.Decimal(data.closingCash).minus(
      shift.openingCash,
    );
    const posPolicies = await this.getPosPolicies(businessId);
    const threshold = posPolicies.shiftVarianceThreshold ?? 0;

    if (threshold > 0 && Math.abs(variance.toNumber()) >= threshold) {
      const approval = await this.approvalsService.requestApproval({
        businessId,
        actionType: 'SHIFT_VARIANCE',
        requestedByUserId: userId,
        requesterRoleIds: roleIds,
        amount: Math.abs(variance.toNumber()),
        metadata: { shiftId, variance: variance.toNumber() },
        targetType: 'Shift',
        targetId: shiftId,
      });
      if (approval.required) {
        return { approvalRequired: true, approvalId: approval.approval?.id };
      }
    }

    const updated = await this.prisma.shift.update({
      where: { id: shiftId },
      data: {
        status: ShiftStatus.CLOSED,
        closedById: userId,
        closedAt: new Date(),
        closingCash: new Prisma.Decimal(data.closingCash),
        variance,
        varianceReason: data.varianceReason ?? null,
      },
    });
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'SHIFT_CLOSE',
      resourceType: 'Shift',
      resourceId: updated.id,
      outcome: 'SUCCESS',
      metadata: { variance: variance.toNumber() },
    });
    return updated;
  }
}
