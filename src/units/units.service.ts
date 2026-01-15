import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, UnitType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_UNIT_CODE = 'piece';

@Injectable()
export class UnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async listUnits(businessId: string) {
    const units = await this.prisma.unit.findMany({
      where: {
        OR: [{ businessId }, { businessId: null }],
      },
      orderBy: [{ businessId: 'asc' }, { code: 'asc' }],
    });
    return units;
  }

  async createUnit(
    businessId: string,
    data: { code: string; label: string; unitType?: UnitType },
  ) {
    const code = data.code.trim().toLowerCase();
    if (!code.match(/^[a-z0-9][a-z0-9-_]*$/)) {
      throw new BadRequestException('Unit code must be alphanumeric.');
    }
    if (!data.label.trim()) {
      throw new BadRequestException('Unit label is required.');
    }
    const existing = await this.prisma.unit.findFirst({
      where: {
        OR: [
          { businessId, code },
          { businessId: null, code },
        ],
      },
    });
    if (existing) {
      throw new BadRequestException('Unit code already exists.');
    }
    const created = await this.prisma.unit.create({
      data: {
        businessId,
        code,
        label: data.label.trim(),
        unitType: data.unitType ?? UnitType.COUNT,
      },
    });
    await this.auditService.logEvent({
      businessId,
      userId: 'system',
      action: 'UNIT_CREATE',
      resourceType: 'Unit',
      resourceId: created.id,
      outcome: 'SUCCESS',
      metadata: {
        code: created.code,
        label: created.label,
        unitType: created.unitType,
      },
      after: created as unknown as Record<string, unknown>,
    });
    return created;
  }

  async resolveDefaultUnitId(businessId: string) {
    const unit = await this.prisma.unit.findFirst({
      where: {
        OR: [
          { businessId, code: DEFAULT_UNIT_CODE },
          { businessId: null, code: DEFAULT_UNIT_CODE },
        ],
      },
    });
    if (!unit) {
      throw new BadRequestException('Default unit not configured.');
    }
    return unit.id;
  }

  async getUnit(businessId: string, unitId: string) {
    const unit = await this.prisma.unit.findFirst({
      where: {
        id: unitId,
        OR: [{ businessId }, { businessId: null }],
      },
    });
    if (!unit) {
      throw new BadRequestException('Unit not found.');
    }
    return unit;
  }

  async resolveVariantUnits(businessId: string, variantId: string) {
    const variant = await this.prisma.variant.findFirst({
      where: { id: variantId, businessId },
      select: {
        id: true,
        baseUnitId: true,
        sellUnitId: true,
        conversionFactor: true,
      },
    });
    if (!variant) {
      throw new BadRequestException('Variant not found.');
    }
    let baseUnitId = variant.baseUnitId;
    let sellUnitId = variant.sellUnitId;
    let conversionFactor = variant.conversionFactor ?? new Prisma.Decimal(1);

    if (!baseUnitId) {
      baseUnitId = await this.resolveDefaultUnitId(businessId);
    }
    if (!sellUnitId) {
      sellUnitId = baseUnitId;
    }
    if (!conversionFactor || conversionFactor.lessThanOrEqualTo(0)) {
      conversionFactor = new Prisma.Decimal(1);
    }

    return { baseUnitId, sellUnitId, conversionFactor };
  }

  async resolveUnitFactor(params: {
    businessId: string;
    variantId: string;
    unitId?: string | null;
  }) {
    const { baseUnitId, sellUnitId, conversionFactor } =
      await this.resolveVariantUnits(params.businessId, params.variantId);
    const selectedUnitId = params.unitId ?? sellUnitId ?? baseUnitId;
    if (selectedUnitId === baseUnitId) {
      return { unitId: selectedUnitId, unitFactor: new Prisma.Decimal(1) };
    }
    if (selectedUnitId === sellUnitId) {
      return { unitId: selectedUnitId, unitFactor: conversionFactor };
    }
    throw new BadRequestException('Unsupported unit for this variant.');
  }

  toBaseQuantity(quantity: Prisma.Decimal, unitFactor: Prisma.Decimal) {
    return quantity.mul(unitFactor);
  }
}
