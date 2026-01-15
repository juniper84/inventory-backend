import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { Prisma } from '@prisma/client';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';

@Injectable()
export class BranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  async list(
    businessId: string,
    query: PaginationQuery & { search?: string; status?: string },
    branchScope: string[] = [],
  ) {
    const pagination = parsePagination(query);
    const search = query.search?.trim();
    const where: Prisma.BranchWhereInput = {
      businessId,
      ...(branchScope.length ? { id: { in: branchScope } } : {}),
      ...(query.status ? { status: query.status as any } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { address: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { phone: { contains: search, mode: Prisma.QueryMode.insensitive } },
            ],
          }
        : {}),
    };
    const items = await this.prisma.branch.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...pagination,
    });
    return buildPaginatedResponse(items, pagination.take);
  }

  async create(
    businessId: string,
    data: {
      name: string;
      address?: string;
      phone?: string;
      priceListId?: string | null;
    },
  ) {
    await this.subscriptionService.assertLimit(businessId, 'branches');
    const result = await this.prisma.branch.create({
      data: {
        businessId,
        name: data.name,
        address: data.address,
        phone: data.phone,
        priceListId: data.priceListId ?? null,
      },
    });
    this.auditService.logEvent({
      businessId,
      userId: 'system',
      action: 'BRANCH_CREATE',
      resourceType: 'Branch',
      resourceId: result.id,
      outcome: 'SUCCESS',
      metadata: data,
    });
    return result;
  }

  async update(
    businessId: string,
    branchId: string,
    data: {
      name?: string;
      address?: string;
      phone?: string;
      priceListId?: string | null;
    },
  ) {
    const before = await this.prisma.branch.findFirst({
      where: { id: branchId, businessId },
    });
    if (!before) {
      return null;
    }
    const result = await this.prisma.branch.update({
      where: { id: branchId },
      data: {
        name: data.name ?? undefined,
        address: data.address ?? undefined,
        phone: data.phone ?? undefined,
        priceListId:
          data.priceListId === undefined ? undefined : data.priceListId,
      },
    });
    this.auditService.logEvent({
      businessId,
      userId: 'system',
      action: 'BRANCH_UPDATE',
      resourceType: 'Branch',
      resourceId: branchId,
      outcome: 'SUCCESS',
      metadata: data,
      before: before as unknown as Record<string, unknown>,
      after: result as unknown as Record<string, unknown>,
    });
    return result;
  }
}
