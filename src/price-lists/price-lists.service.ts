import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';

@Injectable()
export class PriceListsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(
    businessId: string,
    query: PaginationQuery & { search?: string; status?: string },
  ) {
    const pagination = parsePagination(query);
    const search = query.search?.trim();
    const where: Prisma.PriceListWhereInput = {
      businessId,
      ...(query.status ? { status: query.status as any } : {}),
      ...(search
        ? { name: { contains: search, mode: Prisma.QueryMode.insensitive } }
        : {}),
    };
    const items = await this.prisma.priceList.findMany({
      where,
      include: { items: true },
      orderBy: { createdAt: 'desc' },
      ...pagination,
    });

    const customerCounts = await this.prisma.customer.groupBy({
      by: ['priceListId'],
      where: { businessId, priceListId: { not: null } },
      _count: { id: true },
    });
    const countMap = new Map(
      customerCounts.map((c) => [c.priceListId, c._count.id]),
    );
    const enriched = items.map((item) => ({
      ...item,
      customerCount: countMap.get(item.id) ?? 0,
    }));

    return buildPaginatedResponse(enriched, pagination.take);
  }

  async create(businessId: string, userId: string, data: { name: string }) {
    const list = await this.prisma.priceList.create({
      data: {
        businessId,
        name: data.name,
        status: 'ACTIVE',
      },
    });
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'PRICE_LIST_CREATE',
      resourceType: 'PriceList',
      resourceId: list.id,
      outcome: 'SUCCESS',
    });
    return list;
  }

  async update(
    businessId: string,
    userId: string,
    listId: string,
    data: { name?: string; status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' },
  ) {
    // Wrap ownership check + update atomically to prevent TOCTOU race (Fix P3-G6-M4)
    const txResult = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.priceList.findFirst({
        where: { id: listId, businessId },
      });
      if (!existing) {
        return null;
      }
      const updated = await tx.priceList.update({
        where: { id: listId },
        data: {
          name: data.name ?? existing.name,
          status: (data.status ?? existing.status) as any,
        },
      });
      return { existing, updated };
    });
    if (!txResult) {
      return null;
    }
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'PRICE_LIST_UPDATE',
      resourceType: 'PriceList',
      resourceId: txResult.updated.id,
      outcome: 'SUCCESS',
      before: txResult.existing as unknown as Record<string, unknown>,
      after: txResult.updated as unknown as Record<string, unknown>,
    });
    return txResult.updated;
  }

  async setItem(
    businessId: string,
    userId: string,
    listId: string,
    data: { variantId: string; price: number },
  ) {
    const list = await this.prisma.priceList.findFirst({
      where: { id: listId, businessId },
    });
    if (!list) {
      return null;
    }

    // Verify the variant belongs to this business before writing (Fix P3-G6-C1)
    const variant = await this.prisma.variant.findFirst({
      where: { id: data.variantId, product: { businessId } },
    });
    if (!variant) {
      return null;
    }

    // Capture existing price for undo snapshot
    const existing = await this.prisma.priceListItem.findUnique({
      where: {
        priceListId_variantId: {
          priceListId: listId,
          variantId: data.variantId,
        },
      },
    });
    const oldPrice = existing
      ? Number(existing.price)
      : Number(variant.defaultPrice ?? 0);

    const item = await this.prisma.priceListItem.upsert({
      where: {
        priceListId_variantId: {
          priceListId: listId,
          variantId: data.variantId,
        },
      },
      update: { price: new Prisma.Decimal(data.price) },
      create: {
        priceListId: listId,
        variantId: data.variantId,
        price: new Prisma.Decimal(data.price),
      },
    });

    // Save snapshot for undo
    await this.prisma.priceSnapshot.create({
      data: {
        businessId,
        priceListId: listId,
        variantId: data.variantId,
        oldPrice: new Prisma.Decimal(oldPrice),
        newPrice: new Prisma.Decimal(data.price),
        changedById: userId,
      },
    });

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'PRICE_LIST_ITEM_SET',
      resourceType: 'PriceListItem',
      resourceId: item.id,
      outcome: 'SUCCESS',
      metadata: { priceListId: listId, variantId: data.variantId },
    });
    return item;
  }

  async undoLastPriceChange(
    businessId: string,
    priceListId: string,
    userId: string,
  ) {
    const list = await this.prisma.priceList.findFirst({
      where: { id: priceListId, businessId },
    });
    if (!list) {
      return null;
    }

    // Find the most recent snapshot for this price list
    const latest = await this.prisma.priceSnapshot.findFirst({
      where: { businessId, priceListId },
      orderBy: { createdAt: 'desc' },
    });
    if (!latest) {
      return { reverted: 0 };
    }

    // Get all snapshots from the same batch (within 5 seconds of the latest)
    const batchStart = new Date(latest.createdAt.getTime() - 5000);
    const snapshots = await this.prisma.priceSnapshot.findMany({
      where: {
        businessId,
        priceListId,
        createdAt: { gte: batchStart },
      },
    });

    // Revert each price inside a transaction
    await this.prisma.$transaction(async (tx) => {
      for (const snap of snapshots) {
        await tx.priceListItem.updateMany({
          where: { priceListId, variantId: snap.variantId },
          data: { price: snap.oldPrice },
        });
      }
      // Delete the used snapshots
      await tx.priceSnapshot.deleteMany({
        where: { id: { in: snapshots.map((s) => s.id) } },
      });
    });

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'PRICE_LIST_UNDO',
      resourceType: 'PriceList',
      resourceId: priceListId,
      outcome: 'SUCCESS',
      metadata: { revertedCount: snapshots.length },
    });

    return { reverted: snapshots.length };
  }

  async removeItem(
    businessId: string,
    userId: string,
    listId: string,
    itemId: string,
  ) {
    // Wrap ownership checks + delete atomically to prevent TOCTOU race (Fix P4-D-H9)
    const found = await this.prisma.$transaction(async (tx) => {
      const list = await tx.priceList.findFirst({
        where: { id: listId, businessId },
      });
      if (!list) {
        return false;
      }
      const item = await tx.priceListItem.findFirst({
        where: { id: itemId, priceListId: listId },
      });
      if (!item) {
        return false;
      }
      await tx.priceListItem.delete({ where: { id: itemId, priceListId: listId } });
      return true;
    });
    if (!found) {
      return null;
    }
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'PRICE_LIST_ITEM_REMOVE',
      resourceType: 'PriceListItem',
      resourceId: itemId,
      outcome: 'SUCCESS',
    });
    return { removed: true };
  }
}
