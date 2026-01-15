import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
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
              { name: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { phone: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { email: { contains: search, mode: Prisma.QueryMode.insensitive } },
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
    const items = canViewSensitive
      ? customers
      : customers.map((customer) => ({
          ...customer,
          phone: this.maskValue(customer.phone),
          email: customer.email ? this.maskValue(customer.email) : null,
          tin: this.maskValue(customer.tin),
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
    const existing = await this.prisma.customer.findFirst({
      where: { id: customerId, businessId },
    });
    if (!existing) {
      return null;
    }
    const updated = await this.prisma.customer.update({
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
    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'CUSTOMER_UPDATE',
      resourceType: 'Customer',
      resourceId: updated.id,
      outcome: 'SUCCESS',
      before: existing as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });
    return updated;
  }

  async archive(businessId: string, userId: string, customerId: string) {
    const existing = await this.prisma.customer.findFirst({
      where: { id: customerId, businessId },
    });
    if (!existing) {
      return null;
    }
    const updated = await this.prisma.customer.update({
      where: { id: customerId },
      data: { status: 'ARCHIVED' },
    });
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
    const updated = await this.prisma.customer.update({
      where: { id: customerId },
      data: {
        name: `Anonymized ${customerId.slice(0, 8)}`,
        phone: null,
        email: null,
        tin: null,
        notes: 'ANONYMIZED',
        status: 'ARCHIVED',
      },
    });
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

  async exportCsv(businessId: string) {
    const customers = await this.prisma.customer.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
    });
    const header = ['name', 'phone', 'email', 'tin', 'status', 'createdAt'];
    const rows = customers.map((customer) => [
      customer.name,
      customer.phone ?? '',
      customer.email ?? '',
      customer.tin ?? '',
      customer.status,
      customer.createdAt.toISOString(),
    ]);
    return [header.join(','), ...rows.map((row) => row.join(','))].join('\n');
  }
}
