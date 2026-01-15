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
      ...(search ? { name: { contains: search, mode: Prisma.QueryMode.insensitive } } : {}),
    };
    const items = await this.prisma.priceList.findMany({
      where,
      include: { items: true },
      orderBy: { createdAt: 'desc' },
      ...pagination,
    });
    return buildPaginatedResponse(items, pagination.take);
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
    const existing = await this.prisma.priceList.findFirst({
      where: { id: listId, businessId },
    });
    if (!existing) {
      return null;
    }
    const updated = await this.prisma.priceList.update({
      where: { id: listId },
      data: {
        name: data.name ?? existing.name,
        status: (data.status ?? existing.status) as any,
      },
    });
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'PRICE_LIST_UPDATE',
      resourceType: 'PriceList',
      resourceId: updated.id,
      outcome: 'SUCCESS',
      before: existing as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });
    return updated;
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

  async removeItem(
    businessId: string,
    userId: string,
    listId: string,
    itemId: string,
  ) {
    const item = await this.prisma.priceListItem.findFirst({
      where: { id: itemId, priceListId: listId },
    });
    if (!item) {
      return null;
    }
    await this.prisma.priceListItem.delete({ where: { id: itemId } });
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
