import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { toCsv } from '../common/csv';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';

type CustomerCreateInput = {
  name: string;
  phone?: string;
  email?: string;
  tin?: string;
  notes?: string;
  status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  priceListId?: string | null;
};

type CustomerUpdateInput = {
  name?: string;
  phone?: string;
  email?: string;
  tin?: string;
  notes?: string;
  status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  priceListId?: string | null;
};

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  private maskValue(value?: string | null) {
    if (!value) {
      return null;
    }
    const trimmed = value.trim();
    if (trimmed.length <= 4) {
      return '••••';
    }
    return `${'•'.repeat(Math.max(0, trimmed.length - 4))}${trimmed.slice(-4)}`;
  }

  async list(
    businessId: string,
    canViewSensitive: boolean,
    query: PaginationQuery & {
      search?: string;
      status?: string;
      balanceDue?: string;
    },
  ) {
    const pagination = parsePagination(query);
    const search = query.search?.trim();
    const balanceDue = query.balanceDue?.toLowerCase();
    const where: Prisma.CustomerWhereInput = {
      businessId,
      ...(query.status ? { status: query.status as any } : {}),
      ...(balanceDue === 'yes'
        ? { sales: { some: { outstandingAmount: { gt: 0 } } } }
        : balanceDue === 'no'
          ? { sales: { none: { outstandingAmount: { gt: 0 } } } }
          : {}),
      ...(search
        ? {
            OR: [
              {
                name: { contains: search, mode: Prisma.QueryMode.insensitive },
              },
              {
                phone: { contains: search, mode: Prisma.QueryMode.insensitive },
              },
              {
                email: { contains: search, mode: Prisma.QueryMode.insensitive },
              },
              { tin: { contains: search, mode: Prisma.QueryMode.insensitive } },
            ],
          }
        : {}),
    };
    const customers = await this.prisma.customer.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...pagination,
    });
    // Enrich with outstanding balance from sales
    const customerIds = customers.map((c) => c.id);
    const outstandingData = customerIds.length
      ? await this.prisma.sale.groupBy({
          by: ['customerId'],
          where: {
            businessId,
            customerId: { in: customerIds },
            outstandingAmount: { gt: 0 },
          },
          _sum: { outstandingAmount: true },
        })
      : [];
    const outstandingMap = new Map(
      outstandingData.map((o) => [
        o.customerId,
        Number(o._sum.outstandingAmount ?? 0),
      ]),
    );

    const items = customers.map((customer) => ({
      ...(canViewSensitive
        ? customer
        : {
            ...customer,
            phone: this.maskValue(customer.phone),
            email: customer.email ? this.maskValue(customer.email) : null,
            tin: this.maskValue(customer.tin),
          }),
      totalOutstanding: outstandingMap.get(customer.id) ?? 0,
    }));
    return buildPaginatedResponse(items, pagination.take);
  }

  async getById(
    businessId: string,
    customerId: string,
    canViewSensitive: boolean,
  ) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, businessId },
    });
    if (!customer) {
      return null;
    }
    if (canViewSensitive) {
      return customer;
    }
    return {
      ...customer,
      phone: this.maskValue(customer.phone),
      email: customer.email ? this.maskValue(customer.email) : null,
      tin: this.maskValue(customer.tin),
    };
  }

  async create(businessId: string, userId: string, data: CustomerCreateInput) {
    const created = await this.prisma.customer.create({
      data: {
        businessId,
        name: data.name,
        phone: data.phone ?? null,
        email: data.email ?? null,
        tin: data.tin ?? null,
        notes: data.notes ?? null,
        status: (data.status ?? 'ACTIVE') as any,
        priceListId: data.priceListId ?? null,
      },
    });
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'CUSTOMER_CREATE',
      resourceType: 'Customer',
      resourceId: created.id,
      outcome: 'SUCCESS',
    });
    return created;
  }

  async update(
    businessId: string,
    userId: string,
    customerId: string,
    data: CustomerUpdateInput,
  ) {
    // Wrap ownership check + update atomically to prevent TOCTOU race (Fix P3-G6-M1)
    const txResult = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.customer.findFirst({
        where: { id: customerId, businessId },
      });
      if (!existing) {
        return null;
      }
      const updated = await tx.customer.update({
        where: { id: customerId },
        data: {
          name: data.name ?? existing.name,
          phone: data.phone ?? existing.phone,
          email: data.email ?? existing.email,
          tin: data.tin ?? existing.tin,
          notes: data.notes ?? existing.notes,
          status: (data.status ?? existing.status) as any,
          priceListId:
            data.priceListId === undefined
              ? existing.priceListId
              : data.priceListId,
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
      action: 'CUSTOMER_UPDATE',
      resourceType: 'Customer',
      resourceId: txResult.updated.id,
      outcome: 'SUCCESS',
      before: txResult.existing as unknown as Record<string, unknown>,
      after: txResult.updated as unknown as Record<string, unknown>,
    });
    return txResult.updated;
  }

  async archive(businessId: string, userId: string, customerId: string) {
    const existing = await this.prisma.customer.findFirst({
      where: { id: customerId, businessId },
    });
    if (!existing) {
      return null;
    }
    await this.prisma.customer.updateMany({
      where: { id: customerId, businessId },
      data: { status: 'ARCHIVED' },
    });
    const updated = (await this.prisma.customer.findFirst({
      where: { id: customerId, businessId },
    }))!;
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'CUSTOMER_ARCHIVE',
      resourceType: 'Customer',
      resourceId: updated.id,
      outcome: 'SUCCESS',
      before: existing as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });
    return updated;
  }

  async anonymize(businessId: string, userId: string, customerId: string) {
    const existing = await this.prisma.customer.findFirst({
      where: { id: customerId, businessId },
    });
    if (!existing) {
      return null;
    }
    await this.prisma.customer.updateMany({
      where: { id: customerId, businessId },
      data: {
        name: `Anonymized ${customerId.slice(0, 8)}`,
        phone: null,
        email: null,
        tin: null,
        notes: 'ANONYMIZED',
        status: 'ARCHIVED',
      },
    });
    const updated = (await this.prisma.customer.findFirst({
      where: { id: customerId, businessId },
    }))!;
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'CUSTOMER_ANONYMIZE',
      resourceType: 'Customer',
      resourceId: updated.id,
      outcome: 'SUCCESS',
      before: existing as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });
    return updated;
  }

  async getCustomerTimeline(businessId: string, customerId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, businessId },
      select: { id: true },
    });
    if (!customer) {
      return null;
    }
    const [sales, refunds] = await Promise.all([
      this.prisma.sale.findMany({
        where: { businessId, customerId, status: 'COMPLETED' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, referenceNumber: true, total: true, createdAt: true },
      }),
      this.prisma.saleRefund.findMany({
        where: { businessId, customerId, status: 'COMPLETED' },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, total: true, createdAt: true },
      }),
    ]);
    return {
      sales: sales.map((s) => ({ ...s, type: 'sale' as const })),
      refunds: refunds.map((r) => ({ ...r, type: 'refund' as const })),
    };
  }

  async exportCsv(businessId: string, canViewSensitive: boolean) {
    const customers = await this.prisma.customer.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
    });
    const headers = ['name', 'phone', 'email', 'tin', 'status', 'createdAt'];
    const rows = customers.map((customer) => ({
      name: customer.name,
      phone: canViewSensitive
        ? (customer.phone ?? '')
        : (this.maskValue(customer.phone) ?? ''),
      email: canViewSensitive
        ? (customer.email ?? '')
        : (customer.email ? this.maskValue(customer.email) : ''),
      tin: canViewSensitive
        ? (customer.tin ?? '')
        : (this.maskValue(customer.tin) ?? ''),
      status: customer.status,
      createdAt: customer.createdAt.toISOString(),
    }));
    return toCsv(headers, rows);
  }
}
