import { Prisma, PrismaClient } from '@prisma/client';

type IdempotencyClaim =
  | {
      record: {
        id: string;
        resourceType: string | null;
        resourceId: string | null;
      };
      existing: false;
    }
  | {
      record: {
        id: string;
        resourceType: string | null;
        resourceId: string | null;
      };
      existing: true;
    };

export async function claimIdempotency(
  prisma: PrismaClient,
  businessId: string,
  scope: string,
  key?: string,
): Promise<IdempotencyClaim | null> {
  if (!key) {
    return null;
  }
  try {
    const record = await prisma.idempotencyKey.create({
      data: {
        businessId,
        scope,
        key,
        metadata: { status: 'PENDING' } as Prisma.InputJsonValue,
      },
      select: { id: true, resourceId: true, resourceType: true },
    });
    return { record, existing: false };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      const record = await prisma.idempotencyKey.findUnique({
        where: { businessId_scope_key: { businessId, scope, key } },
        select: { id: true, resourceId: true, resourceType: true },
      });
      if (record) {
        return { record, existing: true };
      }
      return null;
    }
    throw err;
  }
}

export async function finalizeIdempotency(
  prisma: PrismaClient,
  recordId: string,
  data: {
    resourceType: string;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  return prisma.idempotencyKey.update({
    where: { id: recordId },
    data: {
      resourceType: data.resourceType,
      resourceId: data.resourceId ?? null,
      metadata: data.metadata
        ? (data.metadata as Prisma.InputJsonValue)
        : undefined,
    },
  });
}

export async function clearIdempotency(prisma: PrismaClient, recordId: string) {
  return prisma.idempotencyKey.delete({ where: { id: recordId } });
}
