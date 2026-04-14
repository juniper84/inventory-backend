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
              {
                name: { contains: search, mode: Prisma.QueryMode.insensitive },
              },
              {
                address: {
                  contains: search,
                  mode: Prisma.QueryMode.insensitive,
                },
              },
              {
                phone: { contains: search, mode: Prisma.QueryMode.insensitive },
              },
            ],
          }
        : {}),
    };
    const items = await this.prisma.branch.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...pagination,
    });

    // Enrich with active user count per branch
    const branchIds = items.map((b) => b.id);
    const userCounts = branchIds.length
      ? await this.prisma.userRole.groupBy({
          by: ['branchId'],
          where: { branchId: { in: branchIds }, role: { businessId } },
          _count: { userId: true },
        })
      : [];
    const userCountMap = new Map(
      userCounts.map((uc) => [uc.branchId, uc._count.userId]),
    );
    const enriched = items.map((item) => ({
      ...item,
      activeUserCount: userCountMap.get(item.id) ?? 0,
    }));

    return buildPaginatedResponse(enriched, pagination.take);
  }

  async getBranchPerformance(businessId: string, branchId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [salesToday, stockValue] = await Promise.all([
      this.prisma.sale.aggregate({
        where: {
          businessId,
          branchId,
          status: 'COMPLETED',
          createdAt: { gte: today },
        },
        _sum: { total: true },
        _count: { id: true },
      }),
      this.prisma.stockSnapshot.aggregate({
        where: { businessId, branchId },
        _sum: { quantity: true },
      }),
    ]);
    return {
      salesToday: Number(salesToday._sum.total ?? 0),
      saleCount: salesToday._count.id,
      stockUnits: Number(stockValue._sum.quantity ?? 0),
    };
  }

  async create(
    businessId: string,
    userId: string,
    data: {
      name: string;
      address?: string;
      phone?: string;
      priceListId?: string | null;
    },
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      await this.subscriptionService.assertLimit(businessId, 'branches', 1, tx);
      return tx.branch.create({
        data: {
          businessId,
          name: data.name,
          address: data.address,
          phone: data.phone,
          priceListId: data.priceListId ?? null,
        },
      });
    });
    this.auditService.logEvent({
      businessId,
      userId,
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
    userId: string,
    data: {
      name?: string;
      address?: string;
      phone?: string;
      priceListId?: string | null;
      openingTime?: string | null;
      closingTime?: string | null;
    },
  ) {
    const before = await this.prisma.branch.findFirst({
      where: { id: branchId, businessId },
    });
    if (!before) {
      return null;
    }
    await this.prisma.branch.updateMany({
      where: { id: branchId, businessId },
      data: {
        name: data.name ?? undefined,
        address: data.address ?? undefined,
        phone: data.phone ?? undefined,
        priceListId:
          data.priceListId === undefined ? undefined : data.priceListId,
        openingTime:
          data.openingTime === undefined ? undefined : data.openingTime,
        closingTime:
          data.closingTime === undefined ? undefined : data.closingTime,
      },
    });
    const result = (await this.prisma.branch.findFirst({
      where: { id: branchId, businessId },
    }))!;
    this.auditService.logEvent({
      businessId,
      userId,
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
