import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { SubscriptionService } from '../subscription/subscription.service';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';

@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly subscriptionService: SubscriptionService,
    private readonly storageService: StorageService,
  ) {}

  private readonly allowedMimeTypes = new Set([
    'image/jpeg',
    'image/png',
    'application/pdf',
  ]);

  private ensureAttachmentConstraints(data: {
    filename: string;
    sizeMb?: number;
    mimeType?: string;
  }) {
    const sizeMb = data.sizeMb ?? 0;
    if (sizeMb > 20) {
      throw new BadRequestException('Attachment exceeds 20MB limit.');
    }
    if (data.mimeType && !this.allowedMimeTypes.has(data.mimeType)) {
      throw new BadRequestException(
        'Attachment type must be JPG, PNG, or PDF.',
      );
    }
  }

  async createPresignedUpload(
    businessId: string,
    data: {
      purchaseId?: string;
      purchaseOrderId?: string;
      filename: string;
      mimeType?: string;
    },
    branchScope: string[] = [],
  ) {
    if (!data.purchaseId && !data.purchaseOrderId) {
      return null;
    }
    await this.assertBranchScope(
      businessId,
      data.purchaseId,
      data.purchaseOrderId,
      branchScope,
    );
    this.ensureAttachmentConstraints({
      filename: data.filename,
      mimeType: data.mimeType,
    });
    const key = `attachments/${businessId}/${Date.now()}-${data.filename}`;
    return this.storageService.createPresignedUpload({
      key,
      contentType: data.mimeType,
    });
  }

  async list(
    businessId: string,
    data: PaginationQuery & {
      purchaseId?: string;
      purchaseOrderId?: string;
    } = {},
    branchScope: string[] = [],
  ) {
    const pagination = parsePagination(data);
    const scopedIds = await this.resolveScopedDocumentIds(
      businessId,
      data.purchaseId,
      data.purchaseOrderId,
      branchScope,
    );
    return this.prisma.attachment
      .findMany({
        where: {
          businessId,
          ...(scopedIds.purchaseId ? { purchaseId: scopedIds.purchaseId } : {}),
          ...(scopedIds.purchaseOrderId
            ? { purchaseOrderId: scopedIds.purchaseOrderId }
            : {}),
          ...(scopedIds.purchaseIds
            ? { purchaseId: { in: scopedIds.purchaseIds } }
            : {}),
          ...(scopedIds.purchaseOrderIds
            ? { purchaseOrderId: { in: scopedIds.purchaseOrderIds } }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        ...pagination,
      })
      .then((items) => buildPaginatedResponse(items, pagination.take));
  }

  async create(
    businessId: string,
    data: {
      purchaseId?: string;
      purchaseOrderId?: string;
      filename: string;
      storageKey?: string;
      url: string;
      sizeMb?: number;
      mimeType?: string;
    },
    branchScope: string[] = [],
  ) {
    await this.assertBranchScope(
      businessId,
      data.purchaseId,
      data.purchaseOrderId,
      branchScope,
    );
    if (data.purchaseId) {
      const purchase = await this.prisma.purchase.findFirst({
        where: { id: data.purchaseId, businessId },
      });
      if (!purchase) {
        return null;
      }
    }
    if (data.purchaseOrderId) {
      const po = await this.prisma.purchaseOrder.findFirst({
        where: { id: data.purchaseOrderId, businessId },
      });
      if (!po) {
        return null;
      }
    }
    this.ensureAttachmentConstraints(data);
    const sizeMb = data.sizeMb ?? 0;
    if (sizeMb > 0) {
      await this.subscriptionService.assertLimit(
        businessId,
        'storageGb',
        sizeMb,
      );
    }
    const existing = await this.prisma.attachment.findFirst({
      where: {
        businessId,
        filename: data.filename,
        status: 'ACTIVE',
        ...(data.purchaseId ? { purchaseId: data.purchaseId } : {}),
        ...(data.purchaseOrderId
          ? { purchaseOrderId: data.purchaseOrderId }
          : {}),
      },
      orderBy: { version: 'desc' },
    });
    if (existing) {
      await this.prisma.attachment.update({
        where: { id: existing.id },
        data: { status: 'ARCHIVED', archivedAt: new Date() },
      });
    }
    const attachment = await this.prisma.attachment.create({
      data: {
        businessId,
        purchaseId: data.purchaseId,
        purchaseOrderId: data.purchaseOrderId,
        filename: data.filename,
        storageKey: data.storageKey ?? null,
        url: data.url,
        mimeType: data.mimeType ?? null,
        sizeMb: sizeMb > 0 ? new Prisma.Decimal(sizeMb) : null,
        version: existing ? existing.version + 1 : 1,
      },
    });

    await this.auditService.logEvent({
      businessId,
      userId: 'system',
      action: 'ATTACHMENT_UPLOAD',
      resourceType: 'Attachment',
      resourceId: attachment.id,
      outcome: 'SUCCESS',
      metadata: data,
    });

    return attachment;
  }

  async remove(
    businessId: string,
    attachmentId: string,
    branchScope: string[] = [],
  ) {
    const existing = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, businessId },
    });
    if (!existing) {
      return null;
    }
    await this.assertBranchScope(
      businessId,
      existing.purchaseId ?? undefined,
      existing.purchaseOrderId ?? undefined,
      branchScope,
    );

    const attachment = await this.prisma.attachment.update({
      where: { id: attachmentId },
      data: { status: 'REMOVED' },
    });

    await this.auditService.logEvent({
      businessId,
      userId: 'system',
      action: 'ATTACHMENT_REMOVE',
      resourceType: 'Attachment',
      resourceId: attachment.id,
      outcome: 'SUCCESS',
    });

    return attachment;
  }

  private async assertBranchScope(
    businessId: string,
    purchaseId?: string,
    purchaseOrderId?: string,
    branchScope: string[] = [],
  ) {
    if (!branchScope.length) {
      return;
    }
    if (purchaseId) {
      const purchase = await this.prisma.purchase.findFirst({
        where: { id: purchaseId, businessId },
        select: { branchId: true },
      });
      if (!purchase || !branchScope.includes(purchase.branchId)) {
        throw new ForbiddenException('Branch-scoped role restriction.');
      }
    }
    if (purchaseOrderId) {
      const po = await this.prisma.purchaseOrder.findFirst({
        where: { id: purchaseOrderId, businessId },
        select: { branchId: true },
      });
      if (!po || !branchScope.includes(po.branchId)) {
        throw new ForbiddenException('Branch-scoped role restriction.');
      }
    }
  }

  private async resolveScopedDocumentIds(
    businessId: string,
    purchaseId: string | undefined,
    purchaseOrderId: string | undefined,
    branchScope: string[] = [],
  ) {
    if (purchaseId || purchaseOrderId) {
      await this.assertBranchScope(
        businessId,
        purchaseId,
        purchaseOrderId,
        branchScope,
      );
      return { purchaseId, purchaseOrderId };
    }
    if (!branchScope.length) {
      return {};
    }
    const [purchases, purchaseOrders] = await Promise.all([
      this.prisma.purchase.findMany({
        where: { businessId, branchId: { in: branchScope } },
        select: { id: true },
      }),
      this.prisma.purchaseOrder.findMany({
        where: { businessId, branchId: { in: branchScope } },
        select: { id: true },
      }),
    ]);
    return {
      purchaseIds: purchases.map((row) => row.id),
      purchaseOrderIds: purchaseOrders.map((row) => row.id),
    };
  }
}
