import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(businessId: string, query: string, branchScope: string[] = []) {
    const q = query.trim();
    if (!q) {
      return {
        products: [],
        variants: [],
        receipts: [],
        customers: [],
        transfers: [],
      };
    }

    const transferScopeFilter = branchScope.length
      ? {
          OR: [
            { sourceBranchId: { in: branchScope } },
            { destinationBranchId: { in: branchScope } },
          ],
        }
      : {};
    const receiptBranchFilter = branchScope.length
      ? { branchId: { in: branchScope } }
      : {};

    const [productMatches, variantMatches, receipts, customers, transfers] =
      await Promise.all([
        this.prisma.product.findMany({
          where: {
            businessId,
            name: { contains: q, mode: Prisma.QueryMode.insensitive },
          },
          include: {
            variants: {
              select: { id: true, name: true, sku: true },
              take: 10,
            },
          },
          take: 10,
        }),
        this.prisma.variant.findMany({
          where: {
            businessId,
            OR: [
              { name: { contains: q, mode: Prisma.QueryMode.insensitive } },
              { sku: { contains: q, mode: Prisma.QueryMode.insensitive } },
              { product: { name: { contains: q, mode: Prisma.QueryMode.insensitive } } },
            ],
          },
          include: {
            product: { select: { name: true } },
          },
          take: 20,
        }),
        this.prisma.receipt.findMany({
          where: {
            sale: { businessId, ...receiptBranchFilter },
            receiptNumber: { contains: q, mode: Prisma.QueryMode.insensitive },
          },
          take: 10,
        }),
        this.prisma.customer.findMany({
          where: {
            businessId,
            OR: [
              { name: { contains: q, mode: Prisma.QueryMode.insensitive } },
              { phone: { contains: q, mode: Prisma.QueryMode.insensitive } },
              { email: { contains: q, mode: Prisma.QueryMode.insensitive } },
              { tin: { contains: q, mode: Prisma.QueryMode.insensitive } },
            ],
          },
          take: 10,
        }),
        this.prisma.transfer.findMany({
          where: {
            businessId,
            ...transferScopeFilter,
            id: { contains: q, mode: Prisma.QueryMode.insensitive },
          },
          include: {
            sourceBranch: { select: { name: true } },
            destinationBranch: { select: { name: true } },
          },
          take: 10,
        }),
      ]);

    const productMap = new Map<
      string,
      {
        id: string;
        name: string;
        variants: { id: string; name: string; sku: string | null }[];
      }
    >();

    productMatches.forEach((product) => {
      productMap.set(product.id, {
        id: product.id,
        name: product.name,
        variants: product.variants.map((variant) => ({
          id: variant.id,
          name: variant.name,
          sku: variant.sku ?? null,
        })),
      });
    });

    variantMatches.forEach((variant) => {
      const productId = variant.productId;
      const existing = productMap.get(productId);
      const entry = existing ?? {
        id: productId,
        name: variant.product?.name ?? 'Unknown product',
        variants: [],
      };
      if (!entry.variants.find((item) => item.id === variant.id)) {
        entry.variants.push({
          id: variant.id,
          name: variant.name,
          sku: variant.sku ?? null,
        });
      }
      productMap.set(productId, entry);
    });

    const products = Array.from(productMap.values()).slice(0, 15);

    return {
      products,
      variants: variantMatches,
      receipts,
      customers,
      transfers,
    };
  }
}
