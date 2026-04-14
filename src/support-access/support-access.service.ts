import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import crypto from 'crypto';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  SupportRequestPriority,
  SupportRequestSeverity,
} from '@prisma/client';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';

const DEFAULT_SUPPORT_ACCESS_HOURS = 4;
const REQUIRED_SUPPORT_ACCESS_TIER = 3;

@Injectable()
export class SupportAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
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

  async createRequest(data: {
    businessId: string;
    platformAdminId: string;
    reason: string;
    scope?: string[];
    durationHours?: number;
    severity?: SupportRequestSeverity;
    priority?: SupportRequestPriority;
  }) {
    const duration =
      typeof data.durationHours === 'number' &&
      Number.isFinite(data.durationHours)
        ? data.durationHours
        : null;
    const request = await this.prisma.supportAccessRequest.create({
      data: {
        businessId: data.businessId,
        platformAdminId: data.platformAdminId,
        reason: data.reason,
        severity: data.severity ?? SupportRequestSeverity.MEDIUM,
        priority: data.priority ?? SupportRequestPriority.MEDIUM,
        scope: data.scope ?? undefined,
        durationHours: duration,
      },
    });

    await this.auditService.logEvent({
      businessId: data.businessId,
      userId: data.platformAdminId,
      action: 'SUPPORT_ACCESS_REQUEST',
      resourceType: 'SupportAccessRequest',
      resourceId: request.id,
      outcome: 'SUCCESS',
      metadata: {
        reason: data.reason,
        severity: data.severity ?? SupportRequestSeverity.MEDIUM,
        priority: data.priority ?? SupportRequestPriority.MEDIUM,
        scope: data.scope ?? null,
        durationHours: duration,
      },
    });

    return request;
  }

  listRequestsForPlatform(
    query: PaginationQuery & {
      status?: string;
      businessId?: string;
      platformAdminId?: string;
      severity?: string;
      priority?: string;
      requestedFrom?: string;
      requestedTo?: string;
    } = {},
  ) {
    const pagination = parsePagination(query);
    const requestedFrom = query.requestedFrom
      ? new Date(query.requestedFrom)
      : null;
    const requestedTo = query.requestedTo ? new Date(query.requestedTo) : null;
    const requestedFromValue =
      requestedFrom && !Number.isNaN(requestedFrom.getTime())
        ? requestedFrom
        : null;
    const requestedToValue =
      requestedTo && !Number.isNaN(requestedTo.getTime()) ? requestedTo : null;
    return this.prisma.supportAccessRequest
      .findMany({
        where: {
          ...(query.platformAdminId
            ? { platformAdminId: query.platformAdminId }
            : {}),
          ...(query.businessId ? { businessId: query.businessId } : {}),
          ...(query.status ? { status: query.status as any } : {}),
          ...(query.severity ? { severity: query.severity as any } : {}),
          ...(query.priority ? { priority: query.priority as any } : {}),
          ...(requestedFromValue || requestedToValue
            ? {
                requestedAt: {
                  ...(requestedFromValue ? { gte: requestedFromValue } : {}),
                  ...(requestedToValue ? { lte: requestedToValue } : {}),
                },
              }
            : {}),
        },
        include: {
          business: { select: { name: true } },
          sessions: {
            where: { revokedAt: null },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        orderBy: { requestedAt: 'desc' },
        ...pagination,
      })
      .then((items) => buildPaginatedResponse(items, pagination.take));
  }

  listSessionsForPlatform(
    query: PaginationQuery & {
      businessId?: string;
      platformAdminId?: string;
      activeOnly?: string;
      requestId?: string;
    } = {},
  ) {
    const pagination = parsePagination(query, 50, 200);
    const now = new Date();
    const activeOnly = query.activeOnly === 'true';
    return this.prisma.supportAccessSession
      .findMany({
        where: {
          ...(query.businessId ? { businessId: query.businessId } : {}),
          ...(query.platformAdminId
            ? { platformAdminId: query.platformAdminId }
            : {}),
          ...(query.requestId ? { requestId: query.requestId } : {}),
          ...(activeOnly
            ? {
                revokedAt: null,
                expiresAt: { gt: now },
              }
            : {}),
        },
        include: {
          business: { select: { name: true } },
          request: {
            select: {
              id: true,
              reason: true,
              status: true,
              severity: true,
              priority: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        ...pagination,
      })
      .then((items) => buildPaginatedResponse(items, pagination.take));
  }

  async revokeSession(data: {
    sessionId: string;
    platformAdminId: string;
    reason: string;
  }) {
    if (!data.reason?.trim()) {
      throw new BadRequestException('Reason is required.');
    }
    const session = await this.prisma.supportAccessSession.findUnique({
      where: { id: data.sessionId },
    });
    if (!session) {
      throw new BadRequestException('Session not found.');
    }
    if (session.platformAdminId !== data.platformAdminId) {
      throw new ForbiddenException('Cannot revoke another admin\'s session.');
    }
    if (session.revokedAt) {
      return session;
    }
    const revoked = await this.prisma.supportAccessSession.update({
      where: { id: data.sessionId },
      data: { revokedAt: new Date() },
    });
    await this.auditService.logEvent({
      businessId: session.businessId,
      userId: data.platformAdminId,
      action: 'SUPPORT_ACCESS_SESSION_REVOKE',
      resourceType: 'SupportAccessSession',
      resourceId: session.id,
      outcome: 'SUCCESS',
      reason: data.reason,
      metadata: {
        requestId: session.requestId,
      },
    });
    return revoked;
  }

  async extendSession(data: {
    sessionId: string;
    platformAdminId: string;
    additionalHours: number;
    reason: string;
  }) {
    if (!data.reason?.trim()) {
      throw new BadRequestException('Reason is required.');
    }
    if (
      !Number.isFinite(data.additionalHours) ||
      data.additionalHours <= 0 ||
      data.additionalHours > 24
    ) {
      throw new BadRequestException(
        'additionalHours must be between 1 and 24.',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.supportAccessSession.findUnique({
        where: { id: data.sessionId },
      });
      if (!session) {
        throw new BadRequestException('Session not found.');
      }
      if (session.revokedAt) {
        throw new BadRequestException('Session is revoked.');
      }
      if (session.expiresAt < new Date()) {
        throw new BadRequestException('Session has already expired.');
      }
      const newExpiresAt = new Date(session.expiresAt);
      newExpiresAt.setHours(
        newExpiresAt.getHours() + data.additionalHours,
      );
      const updated = await tx.supportAccessSession.update({
        where: { id: data.sessionId },
        data: { expiresAt: newExpiresAt },
      });
      await this.auditService.logEvent({
        businessId: session.businessId,
        userId: data.platformAdminId,
        action: 'SUPPORT_ACCESS_SESSION_EXTEND',
        resourceType: 'SupportAccessSession',
        resourceId: session.id,
        outcome: 'SUCCESS',
        reason: data.reason,
        metadata: {
          requestId: session.requestId,
          previousExpiresAt: session.expiresAt.toISOString(),
          newExpiresAt: newExpiresAt.toISOString(),
          additionalHours: data.additionalHours,
        },
      });
      return updated;
    });
  }

  listRequestsForBusiness(
    businessId: string,
    query: PaginationQuery & { status?: string } = {},
  ) {
    const pagination = parsePagination(query);
    return this.prisma.supportAccessRequest
      .findMany({
        where: {
          businessId,
          ...(query.status ? { status: query.status as any } : {}),
        },
        orderBy: { requestedAt: 'desc' },
        ...pagination,
      })
      .then((items) => buildPaginatedResponse(items, pagination.take));
  }

  async approveRequest(data: {
    businessId: string;
    requestId: string;
    approvedByUserId: string;
    durationHours?: number;
    decisionNote?: string;
  }) {
    const approverTier = await this.getUserMaxTier(data.approvedByUserId, data.businessId);
    if (approverTier < REQUIRED_SUPPORT_ACCESS_TIER) {
      throw new ForbiddenException(
        'Only the System Owner can approve support access requests.',
      );
    }
    // Wrap status check + write in $transaction to prevent double-decision race (Fix P4-D-H10)
    const txResult = await this.prisma.$transaction(async (tx) => {
      const request = await tx.supportAccessRequest.findUnique({
        where: { id: data.requestId },
      });
      if (!request || request.businessId !== data.businessId) {
        throw new BadRequestException('Request not found.');
      }
      if (request.status !== 'PENDING') {
        throw new BadRequestException('Request already resolved.');
      }
      const requestedDuration = request.durationHours ?? null;
      const resolvedDuration =
        data.durationHours ?? requestedDuration ?? DEFAULT_SUPPORT_ACCESS_HOURS;
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + resolvedDuration);
      const updated = await tx.supportAccessRequest.update({
        where: { id: request.id },
        data: {
          status: 'APPROVED',
          decidedAt: new Date(),
          expiresAt,
          decisionNote: data.decisionNote ?? null,
          approvedByUserId: data.approvedByUserId,
        },
      });
      return { updated, request, resolvedDuration, expiresAt };
    });

    await this.auditService.logEvent({
      businessId: data.businessId,
      userId: data.approvedByUserId,
      action: 'SUPPORT_ACCESS_APPROVE',
      resourceType: 'SupportAccessRequest',
      resourceId: txResult.request.id,
      outcome: 'SUCCESS',
      metadata: {
        expiresAt: txResult.expiresAt,
        scope: txResult.request.scope ?? null,
        durationHours: txResult.resolvedDuration,
      },
    });

    return txResult.updated;
  }

  async rejectRequest(data: {
    businessId: string;
    requestId: string;
    approvedByUserId: string;
    decisionNote?: string;
  }) {
    const rejecterTier = await this.getUserMaxTier(data.approvedByUserId, data.businessId);
    if (rejecterTier < REQUIRED_SUPPORT_ACCESS_TIER) {
      throw new ForbiddenException(
        'Only the System Owner can reject support access requests.',
      );
    }
    // Wrap status check + write in $transaction to prevent double-decision race (Fix P4-D-H10)
    const txResult = await this.prisma.$transaction(async (tx) => {
      const request = await tx.supportAccessRequest.findUnique({
        where: { id: data.requestId },
      });
      if (!request || request.businessId !== data.businessId) {
        throw new BadRequestException('Request not found.');
      }
      if (request.status !== 'PENDING') {
        throw new BadRequestException('Request already resolved.');
      }
      const updated = await tx.supportAccessRequest.update({
        where: { id: request.id },
        data: {
          status: 'REJECTED',
          decidedAt: new Date(),
          decisionNote: data.decisionNote ?? null,
          approvedByUserId: data.approvedByUserId,
        },
      });
      return { updated, request };
    });

    await this.auditService.logEvent({
      businessId: data.businessId,
      userId: data.approvedByUserId,
      action: 'SUPPORT_ACCESS_REJECT',
      resourceType: 'SupportAccessRequest',
      resourceId: txResult.request.id,
      outcome: 'SUCCESS',
      metadata: { decisionNote: data.decisionNote ?? null },
    });

    return txResult.updated;
  }

  async activateRequest(data: { requestId: string; platformAdminId: string }) {
    const request = await this.prisma.supportAccessRequest.findUnique({
      where: { id: data.requestId },
    });

    if (!request || request.platformAdminId !== data.platformAdminId) {
      throw new BadRequestException('Request not found.');
    }

    if (request.status !== 'APPROVED' || !request.expiresAt) {
      throw new BadRequestException('Request is not approved.');
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    await this.prisma.$transaction(async (tx) => {
      const current = await tx.supportAccessRequest.findUnique({
        where: { id: request.id },
      });
      if (!current || current.status !== 'APPROVED' || !current.expiresAt) {
        throw new BadRequestException('Request is not approved.');
      }
      if (current.expiresAt < new Date()) {
        await tx.supportAccessRequest.update({
          where: { id: request.id },
          data: { status: 'EXPIRED' },
        });
        throw new BadRequestException('Request expired.');
      }
      await tx.supportAccessSession.create({
        data: {
          requestId: request.id,
          businessId: request.businessId,
          platformAdminId: request.platformAdminId,
          tokenHash,
          expiresAt: request.expiresAt ?? new Date(Date.now() + 8 * 60 * 60 * 1000),
          scope: request.scope ?? undefined,
        },
      });
    });

    await this.auditService.logEvent({
      businessId: request.businessId,
      userId: data.platformAdminId,
      action: 'SUPPORT_ACCESS_ACTIVATE',
      resourceType: 'SupportAccessRequest',
      resourceId: request.id,
      outcome: 'SUCCESS',
      metadata: { scope: request.scope ?? null },
    });

    return {
      token,
      expiresAt: request.expiresAt,
      businessId: request.businessId,
    };
  }

  async validateSession(token: string) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const session = await this.prisma.supportAccessSession.findFirst({
      where: { tokenHash, revokedAt: null },
    });

    if (!session || session.expiresAt < new Date()) {
      return null;
    }

    return session;
  }
}
