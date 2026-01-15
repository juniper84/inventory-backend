import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, PurchaseStatus } from '@prisma/client';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';

@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(
    businessId: string,
    query: PaginationQuery & {
      search?: string;
      status?: string;
      balanceDue?: string;
    },
  ) {
    const pagination = parsePagination(query);
    const search = query.search?.trim();
    const balanceDue = query.balanceDue?.toLowerCase();
    const dueStatuses = [
      PurchaseStatus.APPROVED,
      PurchaseStatus.PARTIALLY_RECEIVED,
      PurchaseStatus.FULLY_RECEIVED,
    ];
    const where: Prisma.SupplierWhereInput = {
      businessId,
      ...(query.status ? { status: query.status as any } : {}),
      ...(balanceDue === 'yes'
        ? { purchases: { some: { status: { in: dueStatuses } } } }
        : balanceDue === 'no'
          ? { purchases: { none: { status: { in: dueStatuses } } } }
          : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { phone: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { email: { contains: search, mode: Prisma.QueryMode.insensitive } },
            ],
          }
        : {}),
    };
    const items = await this.prisma.supplier.findMany({
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
      phone?: string;
      email?: string;
      address?: string;
      notes?: string;
      leadTimeDays?: number;
      status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
    },
  ) {
    const supplier = await this.prisma.supplier.create({
      data: {
        businessId,
        name: data.name,
        phone: data.phone,
        email: data.email,
        address: data.address,
        notes: data.notes,
        leadTimeDays: data.leadTimeDays ?? null,
        status: (data.status ?? 'ACTIVE') as any,
      },
    });

    await this.auditService.logEvent({
      businessId,
      userId: 'system',
      action: 'SUPPLIER_CREATE',
      resourceType: 'Supplier',
      resourceId: supplier.id,
      outcome: 'SUCCESS',
      metadata: data,
    });

    return supplier;
  }

  async update(
    businessId: string,
    supplierId: string,
    data: {
      name?: string;
      phone?: string;
      email?: string;
      address?: string;
      notes?: string;
      leadTimeDays?: number;
      status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
    },
  ) {
    const before = await this.prisma.supplier.findFirst({
      where: { id: supplierId, businessId },
    });
    if (!before) {
      return null;
    }

    const updated = await this.prisma.supplier.update({
      where: { id: supplierId },
      data: {
        ...data,
        leadTimeDays:
          data.leadTimeDays === undefined ? undefined : data.leadTimeDays,
      },
    });

    await this.auditService.logEvent({
      businessId,
      userId: 'system',
      action: 'SUPPLIER_UPDATE',
      resourceType: 'Supplier',
      resourceId: updated.id,
      outcome: 'SUCCESS',
      metadata: data,
      before: before as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });

    return updated;
  }
}
