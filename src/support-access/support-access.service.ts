import { BadRequestException, Injectable } from '@nestjs/common';
import crypto from 'crypto';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';

const DEFAULT_SUPPORT_ACCESS_HOURS = 4;

@Injectable()
export class SupportAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async createRequest(data: {
    businessId: string;
    platformAdminId: string;
    reason: string;
    scope?: string[];
    durationHours?: number;
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
        scope: data.scope ?? null,
        durationHours: duration,
      },
    });

    return request;
  }

  listRequestsForPlatform(
    platformAdminId: string,
    query: PaginationQuery & { status?: string } = {},
  ) {
    const pagination = parsePagination(query);
    return this.prisma.supportAccessRequest
      .findMany({
        where: {
          platformAdminId,
          ...(query.status ? { status: query.status as any } : {}),
        },
        orderBy: { requestedAt: 'desc' },
        ...pagination,
      })
      .then((items) => buildPaginatedResponse(items, pagination.take));
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
    const request = await this.prisma.supportAccessRequest.findUnique({
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

    const updated = await this.prisma.supportAccessRequest.update({
      where: { id: request.id },
      data: {
        status: 'APPROVED',
        decidedAt: new Date(),
        expiresAt,
        decisionNote: data.decisionNote ?? null,
        approvedByUserId: data.approvedByUserId,
      },
    });

    await this.auditService.logEvent({
      businessId: data.businessId,
      userId: data.approvedByUserId,
      action: 'SUPPORT_ACCESS_APPROVE',
      resourceType: 'SupportAccessRequest',
      resourceId: request.id,
      outcome: 'SUCCESS',
      metadata: {
        expiresAt,
        scope: request.scope ?? null,
        durationHours: resolvedDuration,
      },
    });

    return updated;
  }

  async rejectRequest(data: {
    businessId: string;
    requestId: string;
    approvedByUserId: string;
    decisionNote?: string;
  }) {
    const request = await this.prisma.supportAccessRequest.findUnique({
      where: { id: data.requestId },
    });

    if (!request || request.businessId !== data.businessId) {
      throw new BadRequestException('Request not found.');
    }

    if (request.status !== 'PENDING') {
      throw new BadRequestException('Request already resolved.');
    }

    const updated = await this.prisma.supportAccessRequest.update({
      where: { id: request.id },
      data: {
        status: 'REJECTED',
        decidedAt: new Date(),
        decisionNote: data.decisionNote ?? null,
        approvedByUserId: data.approvedByUserId,
      },
    });

    await this.auditService.logEvent({
      businessId: data.businessId,
      userId: data.approvedByUserId,
      action: 'SUPPORT_ACCESS_REJECT',
      resourceType: 'SupportAccessRequest',
      resourceId: request.id,
      outcome: 'SUCCESS',
      metadata: { decisionNote: data.decisionNote ?? null },
    });

    return updated;
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

    if (request.expiresAt < new Date()) {
      await this.prisma.supportAccessRequest.update({
        where: { id: request.id },
        data: { status: 'EXPIRED' },
      });
      throw new BadRequestException('Request expired.');
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    await this.prisma.supportAccessSession.create({
      data: {
        requestId: request.id,
        businessId: request.businessId,
        platformAdminId: request.platformAdminId,
        tokenHash,
        expiresAt: request.expiresAt,
        scope: request.scope ?? undefined,
      },
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
