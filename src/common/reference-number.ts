import { PrismaClient } from '@prisma/client';

type PrismaLike = Pick<PrismaClient, 'sale' | 'purchase' | 'purchaseOrder' | 'transfer' | 'supplierReturn' | 'shift' | 'expense' | 'approval'>;

const PREFIXES: Record<string, string> = {
  sale: 'SAL',
  purchase: 'PUR',
  purchaseOrder: 'PO',
  transfer: 'TRF',
  supplierReturn: 'RET',
  shift: 'SHF',
  expense: 'EXP',
  approval: 'APR',
};

/**
 * Generates the next sequential reference number for a given entity type within a business.
 * Format: PREFIX-001, PREFIX-002, etc.
 *
 * Uses a count query to determine the next number. In high-concurrency scenarios,
 * a unique constraint on (businessId, referenceNumber) per model would prevent duplicates.
 */
export async function generateReferenceNumber(
  prisma: PrismaLike | Record<string, unknown>,
  entityType: keyof typeof PREFIXES,
  businessId: string,
): Promise<string> {
  const prefix = PREFIXES[entityType];
  if (!prefix) {
    throw new Error(`Unknown entity type: ${entityType}`);
  }

  const delegate = (prisma as Record<string, unknown>)[entityType] as {
    count: (args: { where: Record<string, unknown> }) => Promise<number>;
  };

  const count = await delegate.count({
    where: { businessId },
  });

  const nextNumber = count + 1;
  const padded = String(nextNumber).padStart(3, '0');
  return `${prefix}-${padded}`;
}
