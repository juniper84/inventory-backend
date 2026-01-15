import { PrismaService } from '../prisma/prisma.service';
import { formatVariantLabel, labelWithFallback } from './labels';

type ResolveParams = {
  businessId: string;
  resourceType?: string | null;
  resourceId?: string | null;
};

export async function resolveResourceName(
  prisma: PrismaService,
  params: ResolveParams,
): Promise<string | null> {
  const resourceType = params.resourceType?.trim();
  const resourceId = params.resourceId?.trim();
  if (!resourceType || !resourceId) {
    return null;
  }

  switch (resourceType) {
    case 'Product': {
      const product = await prisma.product.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { name: true },
      });
      return product
        ? labelWithFallback({ name: product.name, id: resourceId })
        : null;
    }
    case 'Variant': {
      const variant = await prisma.variant.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { name: true, product: { select: { name: true } } },
      });
      if (!variant) {
        return null;
      }
      return formatVariantLabel({
        id: resourceId,
        name: variant.name,
        productName: variant.product?.name ?? null,
      });
    }
    case 'Category': {
      const category = await prisma.category.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { name: true },
      });
      return category
        ? labelWithFallback({ name: category.name, id: resourceId })
        : null;
    }
    case 'Customer': {
      const customer = await prisma.customer.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { name: true },
      });
      return customer
        ? labelWithFallback({ name: customer.name, id: resourceId })
        : null;
    }
    case 'Supplier': {
      const supplier = await prisma.supplier.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { name: true },
      });
      return supplier
        ? labelWithFallback({ name: supplier.name, id: resourceId })
        : null;
    }
    case 'Branch': {
      const branch = await prisma.branch.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { name: true },
      });
      return branch
        ? labelWithFallback({ name: branch.name, id: resourceId })
        : null;
    }
    case 'User': {
      const user = await prisma.user.findFirst({
        where: { id: resourceId },
        select: { name: true, email: true },
      });
      if (!user) {
        return null;
      }
      const label = user.name?.trim() || user.email?.trim();
      return labelWithFallback({ name: label, id: resourceId });
    }
    case 'Role': {
      const role = await prisma.role.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { name: true },
      });
      return role
        ? labelWithFallback({ name: role.name, id: resourceId })
        : null;
    }
    case 'PriceList': {
      const priceList = await prisma.priceList.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { name: true },
      });
      return priceList
        ? labelWithFallback({ name: priceList.name, id: resourceId })
        : null;
    }
    case 'Notification': {
      const notification = await prisma.notification.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { title: true },
      });
      return notification?.title
        ? labelWithFallback({ name: notification.title, id: resourceId })
        : null;
    }
    case 'StockMovement': {
      const movement = await prisma.stockMovement.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: {
          variant: {
            select: { name: true, product: { select: { name: true } } },
          },
        },
      });
      if (!movement?.variant) {
        return null;
      }
      return formatVariantLabel({
        id: resourceId,
        name: movement.variant.name,
        productName: movement.variant.product?.name ?? null,
      });
    }
    case 'ApprovalPolicy': {
      const policy = await prisma.approvalPolicy.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { actionType: true },
      });
      return policy
        ? labelWithFallback({ name: policy.actionType, id: resourceId })
        : null;
    }
    case 'Approval': {
      const approval = await prisma.approval.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: {
          actionType: true,
          status: true,
          targetType: true,
          targetId: true,
        },
      });
      if (!approval) {
        return null;
      }
      const target = approval.targetType?.trim();
      const targetLabel =
        target &&
        approval.targetId &&
        target !== 'Approval' &&
        target !== 'ApprovalPolicy'
          ? await resolveResourceName(prisma, {
              businessId: params.businessId,
              resourceType: target,
              resourceId: approval.targetId,
            })
          : null;
      const label = targetLabel
        ? `${approval.actionType} ${targetLabel}`
        : target
          ? `${approval.actionType} ${target}`
          : approval.actionType;
      return labelWithFallback({ name: label, id: resourceId });
    }
    case 'Attachment': {
      const attachment = await prisma.attachment.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { filename: true },
      });
      return attachment
        ? labelWithFallback({ name: attachment.filename, id: resourceId })
        : null;
    }
    case 'Barcode': {
      const barcode = await prisma.barcode.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { code: true },
      });
      return barcode
        ? labelWithFallback({ name: barcode.code, id: resourceId })
        : null;
    }
    case 'Batch': {
      const batch = await prisma.batch.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: {
          code: true,
          variant: {
            select: { name: true, product: { select: { name: true } } },
          },
        },
      });
      if (!batch) {
        return null;
      }
      const label = batch.variant
        ? `${batch.code} (${formatVariantLabel({
            id: resourceId,
            name: batch.variant.name,
            productName: batch.variant.product?.name ?? null,
          })})`
        : batch.code;
      return labelWithFallback({ name: label, id: resourceId });
    }
    case 'StockSnapshot': {
      const snapshot = await prisma.stockSnapshot.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: {
          variant: {
            select: { name: true, product: { select: { name: true } } },
          },
          branch: { select: { name: true } },
        },
      });
      if (!snapshot?.variant) {
        return null;
      }
      const variantLabel = formatVariantLabel({
        id: resourceId,
        name: snapshot.variant.name,
        productName: snapshot.variant.product?.name ?? null,
      });
      const label = snapshot.branch?.name
        ? `${snapshot.branch.name}: ${variantLabel}`
        : variantLabel;
      return labelWithFallback({ name: label, id: resourceId });
    }
    case 'Unit': {
      const unit = await prisma.unit.findFirst({
        where: {
          id: resourceId,
          OR: [{ businessId: params.businessId }, { businessId: null }],
        },
        select: { code: true, label: true },
      });
      if (!unit) {
        return null;
      }
      const name = unit.label?.trim()
        ? `${unit.label} (${unit.code})`
        : unit.code;
      return labelWithFallback({ name, id: resourceId });
    }
    case 'Business': {
      const business = await prisma.business.findFirst({
        where: { id: resourceId },
        select: { name: true },
      });
      return business
        ? labelWithFallback({ name: business.name, id: resourceId })
        : null;
    }
    case 'BusinessSettings': {
      const settings = await prisma.businessSettings.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { business: { select: { name: true } } },
      });
      const name = settings?.business?.name
        ? `${settings.business.name} settings`
        : null;
      return settings
        ? labelWithFallback({
            name,
            id: resourceId,
            fallback: 'Business settings',
          })
        : null;
    }
    case 'Expense': {
      const expense = await prisma.expense.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { category: true, amount: true, currency: true },
      });
      if (!expense) {
        return null;
      }
      const label = `${expense.category} ${expense.amount} ${expense.currency}`;
      return labelWithFallback({ name: label, id: resourceId });
    }
    case 'ExportJob': {
      const job = await prisma.exportJob.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { type: true, status: true },
      });
      if (!job) {
        return null;
      }
      const label = `${job.type} (${job.status})`;
      return labelWithFallback({ name: label, id: resourceId });
    }
    case 'Invitation': {
      const invite = await prisma.invitation.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { email: true },
      });
      return invite
        ? labelWithFallback({ name: invite.email, id: resourceId })
        : null;
    }
    case 'OfflineAction': {
      const action = await prisma.offlineAction.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { actionType: true },
      });
      return action
        ? labelWithFallback({ name: action.actionType, id: resourceId })
        : null;
    }
    case 'OfflineDevice': {
      const device = await prisma.offlineDevice.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { deviceName: true },
      });
      return device
        ? labelWithFallback({ name: device.deviceName, id: resourceId })
        : null;
    }
    case 'Permission': {
      const permission = await prisma.permission.findFirst({
        where: { id: resourceId },
        select: { code: true },
      });
      return permission
        ? labelWithFallback({ name: permission.code, id: resourceId })
        : null;
    }
    case 'PlatformAnnouncement': {
      const announcement = await prisma.platformAnnouncement.findFirst({
        where: { id: resourceId },
        select: { title: true },
      });
      return announcement
        ? labelWithFallback({ name: announcement.title, id: resourceId })
        : null;
    }
    case 'PriceListItem': {
      const item = await prisma.priceListItem.findFirst({
        where: { id: resourceId, priceList: { businessId: params.businessId } },
        select: {
          priceList: { select: { name: true } },
          variant: {
            select: { name: true, product: { select: { name: true } } },
          },
        },
      });
      if (!item?.priceList || !item.variant) {
        return null;
      }
      const label = `${item.priceList.name}: ${formatVariantLabel({
        id: resourceId,
        name: item.variant.name,
        productName: item.variant.product?.name ?? null,
      })}`;
      return labelWithFallback({ name: label, id: resourceId });
    }
    case 'Purchase': {
      const purchase = await prisma.purchase.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { supplier: { select: { name: true } } },
      });
      return purchase?.supplier?.name
        ? labelWithFallback({ name: purchase.supplier.name, id: resourceId })
        : null;
    }
    case 'PurchaseOrder': {
      const purchaseOrder = await prisma.purchaseOrder.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { supplier: { select: { name: true } } },
      });
      return purchaseOrder?.supplier?.name
        ? labelWithFallback({
            name: purchaseOrder.supplier.name,
            id: resourceId,
          })
        : null;
    }
    case 'PurchasePayment': {
      const payment = await prisma.purchasePayment.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { method: true, amount: true },
      });
      if (!payment) {
        return null;
      }
      const label = `${payment.method} ${payment.amount}`;
      return labelWithFallback({ name: label, id: resourceId });
    }
    case 'Receipt': {
      const receipt = await prisma.receipt.findFirst({
        where: { id: resourceId },
        select: { receiptNumber: true, sale: { select: { businessId: true } } },
      });
      if (!receipt || receipt.sale?.businessId !== params.businessId) {
        return null;
      }
      return labelWithFallback({ name: receipt.receiptNumber, id: resourceId });
    }
    case 'ReceivingLine': {
      const line = await prisma.receivingLine.findFirst({
        where: { id: resourceId, variant: { businessId: params.businessId } },
        select: {
          quantity: true,
          variant: {
            select: { name: true, product: { select: { name: true } } },
          },
        },
      });
      if (!line?.variant) {
        return null;
      }
      const label = `${formatVariantLabel({
        id: resourceId,
        name: line.variant.name,
        productName: line.variant.product?.name ?? null,
      })} x ${line.quantity}`;
      return labelWithFallback({ name: label, id: resourceId });
    }
    case 'ReorderPoint': {
      const point = await prisma.reorderPoint.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: {
          branch: { select: { name: true } },
          variant: {
            select: { name: true, product: { select: { name: true } } },
          },
        },
      });
      if (!point?.variant) {
        return null;
      }
      const variantLabel = formatVariantLabel({
        id: resourceId,
        name: point.variant.name,
        productName: point.variant.product?.name ?? null,
      });
      const label = point.branch?.name
        ? `${point.branch.name}: ${variantLabel}`
        : variantLabel;
      return labelWithFallback({ name: label, id: resourceId });
    }
    case 'RefreshToken': {
      const token = await prisma.refreshToken.findFirst({
        where: { id: resourceId },
        select: { user: { select: { name: true, email: true } } },
      });
      if (!token?.user) {
        return null;
      }
      const label = token.user.name?.trim() || token.user.email?.trim();
      return labelWithFallback({ name: label, id: resourceId });
    }
    case 'Sale': {
      const sale = await prisma.sale.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: {
          completionKey: true,
          receipt: { select: { receiptNumber: true } },
        },
      });
      if (!sale) {
        return null;
      }
      const label = sale.receipt?.receiptNumber ?? sale.completionKey ?? null;
      return labelWithFallback({ name: label, id: resourceId });
    }
    case 'SaleRefund': {
      const refund = await prisma.saleRefund.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: {
          customerNameSnapshot: true,
          sale: { select: { receipt: { select: { receiptNumber: true } } } },
        },
      });
      if (!refund) {
        return null;
      }
      const label =
        refund.sale?.receipt?.receiptNumber ??
        refund.customerNameSnapshot ??
        null;
      return labelWithFallback({ name: label, id: resourceId });
    }
    case 'SaleSettlement': {
      const settlement = await prisma.saleSettlement.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { method: true, amount: true },
      });
      if (!settlement) {
        return null;
      }
      const label = `${settlement.method} ${settlement.amount}`;
      return labelWithFallback({ name: label, id: resourceId });
    }
    case 'Shift': {
      const shift = await prisma.shift.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { branch: { select: { name: true } } },
      });
      const label = shift?.branch?.name ? `Shift ${shift.branch.name}` : null;
      return shift ? labelWithFallback({ name: label, id: resourceId }) : null;
    }
    case 'Subscription': {
      const subscription = await prisma.subscription.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { tier: true, status: true },
      });
      if (!subscription) {
        return null;
      }
      const label = `${subscription.tier} (${subscription.status})`;
      return labelWithFallback({ name: label, id: resourceId });
    }
    case 'SubscriptionRequest': {
      const request = await prisma.subscriptionRequest.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { type: true, requestedTier: true, status: true },
      });
      if (!request) {
        return null;
      }
      const label = request.requestedTier
        ? `${request.type} ${request.requestedTier}`
        : request.type;
      return labelWithFallback({ name: label, id: resourceId });
    }
    case 'SupportAccessRequest': {
      const request = await prisma.supportAccessRequest.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { business: { select: { name: true } }, status: true },
      });
      if (!request) {
        return null;
      }
      const label = request.business?.name
        ? `${request.business.name} (${request.status})`
        : request.status;
      return labelWithFallback({ name: label, id: resourceId });
    }
    case 'SupplierReturn': {
      const supplierReturn = await prisma.supplierReturn.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: { supplier: { select: { name: true } } },
      });
      return supplierReturn?.supplier?.name
        ? labelWithFallback({
            name: supplierReturn.supplier.name,
            id: resourceId,
          })
        : null;
    }
    case 'Transfer': {
      const transfer = await prisma.transfer.findFirst({
        where: { id: resourceId, businessId: params.businessId },
        select: {
          sourceBranch: { select: { name: true } },
          destinationBranch: { select: { name: true } },
        },
      });
      if (!transfer) {
        return null;
      }
      const source = transfer.sourceBranch?.name?.trim();
      const destination = transfer.destinationBranch?.name?.trim();
      const label =
        source && destination
          ? `${source} -> ${destination}`
          : (source ?? destination ?? null);
      return labelWithFallback({ name: label, id: resourceId });
    }
    case 'UserRole': {
      const userRole = await prisma.userRole.findFirst({
        where: { id: resourceId, role: { businessId: params.businessId } },
        select: {
          user: { select: { name: true, email: true } },
          role: { select: { name: true } },
          branch: { select: { name: true } },
        },
      });
      if (!userRole) {
        return null;
      }
      const userLabel =
        userRole.user?.name?.trim() || userRole.user?.email?.trim();
      const roleLabel = userRole.role?.name?.trim();
      const branchLabel = userRole.branch?.name?.trim();
      const label = [userLabel, roleLabel, branchLabel]
        .filter(Boolean)
        .join(' - ');
      return labelWithFallback({ name: label, id: resourceId });
    }
    default:
      return null;
  }
}

export async function resolveResourceNames(
  prisma: PrismaService,
  businessId: string,
  items: Array<{ resourceType?: string | null; resourceId?: string | null }>,
) {
  const idsByType = new Map<string, Set<string>>();
  items.forEach((item) => {
    const type = item.resourceType?.trim();
    const id = item.resourceId?.trim();
    if (!type || !id) {
      return;
    }
    if (!idsByType.has(type)) {
      idsByType.set(type, new Set());
    }
    idsByType.get(type)?.add(id);
  });

  const labels = new Map<string, string>();
  const toKey = (type: string, id: string) => `${type}:${id}`;

  const branchIds = idsByType.get('Branch');
  if (branchIds?.size) {
    const branches = await prisma.branch.findMany({
      where: { id: { in: Array.from(branchIds) }, businessId },
      select: { id: true, name: true },
    });
    branches.forEach((branch) => {
      labels.set(
        toKey('Branch', branch.id),
        labelWithFallback({ name: branch.name, id: branch.id }),
      );
    });
  }

  const roleIds = idsByType.get('Role');
  if (roleIds?.size) {
    const roles = await prisma.role.findMany({
      where: { id: { in: Array.from(roleIds) }, businessId },
      select: { id: true, name: true },
    });
    roles.forEach((role) => {
      labels.set(
        toKey('Role', role.id),
        labelWithFallback({ name: role.name, id: role.id }),
      );
    });
  }

  const userIds = idsByType.get('User');
  if (userIds?.size) {
    const users = await prisma.user.findMany({
      where: { id: { in: Array.from(userIds) } },
      select: { id: true, name: true, email: true },
    });
    users.forEach((user) => {
      const label = user.name?.trim() || user.email?.trim();
      labels.set(
        toKey('User', user.id),
        labelWithFallback({ name: label, id: user.id }),
      );
    });
  }

  const categoryIds = idsByType.get('Category');
  if (categoryIds?.size) {
    const categories = await prisma.category.findMany({
      where: { id: { in: Array.from(categoryIds) }, businessId },
      select: { id: true, name: true },
    });
    categories.forEach((category) => {
      labels.set(
        toKey('Category', category.id),
        labelWithFallback({ name: category.name, id: category.id }),
      );
    });
  }

  const productIds = idsByType.get('Product');
  if (productIds?.size) {
    const products = await prisma.product.findMany({
      where: { id: { in: Array.from(productIds) }, businessId },
      select: { id: true, name: true },
    });
    products.forEach((product) => {
      labels.set(
        toKey('Product', product.id),
        labelWithFallback({ name: product.name, id: product.id }),
      );
    });
  }

  const variantIds = idsByType.get('Variant');
  if (variantIds?.size) {
    const variants = await prisma.variant.findMany({
      where: { id: { in: Array.from(variantIds) }, businessId },
      select: { id: true, name: true, product: { select: { name: true } } },
    });
    variants.forEach((variant) => {
      const variantName = labelWithFallback({
        name: variant.name,
        id: variant.id,
      });
      const productName = variant.product?.name?.trim();
      const label = productName
        ? `${productName} - ${variantName}`
        : variantName;
      labels.set(toKey('Variant', variant.id), label);
    });
  }

  const customerIds = idsByType.get('Customer');
  if (customerIds?.size) {
    const customers = await prisma.customer.findMany({
      where: { id: { in: Array.from(customerIds) }, businessId },
      select: { id: true, name: true },
    });
    customers.forEach((customer) => {
      labels.set(
        toKey('Customer', customer.id),
        labelWithFallback({ name: customer.name, id: customer.id }),
      );
    });
  }

  const supplierIds = idsByType.get('Supplier');
  if (supplierIds?.size) {
    const suppliers = await prisma.supplier.findMany({
      where: { id: { in: Array.from(supplierIds) }, businessId },
      select: { id: true, name: true },
    });
    suppliers.forEach((supplier) => {
      labels.set(
        toKey('Supplier', supplier.id),
        labelWithFallback({ name: supplier.name, id: supplier.id }),
      );
    });
  }

  const priceListIds = idsByType.get('PriceList');
  if (priceListIds?.size) {
    const priceLists = await prisma.priceList.findMany({
      where: { id: { in: Array.from(priceListIds) }, businessId },
      select: { id: true, name: true },
    });
    priceLists.forEach((priceList) => {
      labels.set(
        toKey('PriceList', priceList.id),
        labelWithFallback({ name: priceList.name, id: priceList.id }),
      );
    });
  }

  const notificationIds = idsByType.get('Notification');
  if (notificationIds?.size) {
    const notifications = await prisma.notification.findMany({
      where: { id: { in: Array.from(notificationIds) }, businessId },
      select: { id: true, title: true },
    });
    notifications.forEach((notification) => {
      if (!notification.title) {
        return;
      }
      labels.set(
        toKey('Notification', notification.id),
        labelWithFallback({ name: notification.title, id: notification.id }),
      );
    });
  }

  const movementIds = idsByType.get('StockMovement');
  if (movementIds?.size) {
    const movements = await prisma.stockMovement.findMany({
      where: { id: { in: Array.from(movementIds) }, businessId },
      select: {
        id: true,
        variant: {
          select: { name: true, product: { select: { name: true } } },
        },
      },
    });
    movements.forEach((movement) => {
      if (!movement.variant) {
        return;
      }
      labels.set(
        toKey('StockMovement', movement.id),
        formatVariantLabel({
          id: movement.id,
          name: movement.variant.name,
          productName: movement.variant.product?.name ?? null,
        }),
      );
    });
  }

  const approvalPolicyIds = idsByType.get('ApprovalPolicy');
  if (approvalPolicyIds?.size) {
    const policies = await prisma.approvalPolicy.findMany({
      where: { id: { in: Array.from(approvalPolicyIds) }, businessId },
      select: { id: true, actionType: true },
    });
    policies.forEach((policy) => {
      labels.set(
        toKey('ApprovalPolicy', policy.id),
        labelWithFallback({ name: policy.actionType, id: policy.id }),
      );
    });
  }

  const approvalIds = idsByType.get('Approval');
  if (approvalIds?.size) {
    const approvals = await prisma.approval.findMany({
      where: { id: { in: Array.from(approvalIds) }, businessId },
      select: {
        id: true,
        actionType: true,
        targetType: true,
        targetId: true,
      },
    });
    const targetRefs = approvals
      .map((approval) => {
        const targetType = approval.targetType?.trim();
        const targetId = approval.targetId?.trim();
        if (!targetType || !targetId) {
          return null;
        }
        if (targetType === 'Approval' || targetType === 'ApprovalPolicy') {
          return null;
        }
        return { targetType, targetId };
      })
      .filter(
        (
          ref,
        ): ref is {
          targetType: string;
          targetId: string;
        } => Boolean(ref),
      );
    const targetLabelMap = new Map<string, string>();
    if (targetRefs.length) {
      const resolved = await Promise.all(
        targetRefs.map((ref) =>
          resolveResourceName(prisma, {
            businessId,
            resourceType: ref.targetType,
            resourceId: ref.targetId,
          }),
        ),
      );
      targetRefs.forEach((ref, idx) => {
        const label = resolved[idx];
        if (label) {
          targetLabelMap.set(`${ref.targetType}:${ref.targetId}`, label);
        }
      });
    }
    approvals.forEach((approval) => {
      const target = approval.targetType?.trim();
      const targetId = approval.targetId?.trim();
      const targetLabel =
        target && targetId
          ? targetLabelMap.get(`${target}:${targetId}`) ?? null
          : null;
      const label = targetLabel
        ? `${approval.actionType} ${targetLabel}`
        : target
          ? `${approval.actionType} ${target}`
          : approval.actionType;
      labels.set(
        toKey('Approval', approval.id),
        labelWithFallback({ name: label, id: approval.id }),
      );
    });
  }

  const attachmentIds = idsByType.get('Attachment');
  if (attachmentIds?.size) {
    const attachments = await prisma.attachment.findMany({
      where: { id: { in: Array.from(attachmentIds) }, businessId },
      select: { id: true, filename: true },
    });
    attachments.forEach((attachment) => {
      labels.set(
        toKey('Attachment', attachment.id),
        labelWithFallback({ name: attachment.filename, id: attachment.id }),
      );
    });
  }

  const barcodeIds = idsByType.get('Barcode');
  if (barcodeIds?.size) {
    const barcodes = await prisma.barcode.findMany({
      where: { id: { in: Array.from(barcodeIds) }, businessId },
      select: { id: true, code: true },
    });
    barcodes.forEach((barcode) => {
      labels.set(
        toKey('Barcode', barcode.id),
        labelWithFallback({ name: barcode.code, id: barcode.id }),
      );
    });
  }

  const batchIds = idsByType.get('Batch');
  if (batchIds?.size) {
    const batches = await prisma.batch.findMany({
      where: { id: { in: Array.from(batchIds) }, businessId },
      select: {
        id: true,
        code: true,
        variant: {
          select: { name: true, product: { select: { name: true } } },
        },
      },
    });
    batches.forEach((batch) => {
      const label = batch.variant
        ? `${batch.code} (${formatVariantLabel({
            id: batch.id,
            name: batch.variant.name,
            productName: batch.variant.product?.name ?? null,
          })})`
        : batch.code;
      labels.set(
        toKey('Batch', batch.id),
        labelWithFallback({ name: label, id: batch.id }),
      );
    });
  }

  const stockSnapshotIds = idsByType.get('StockSnapshot');
  if (stockSnapshotIds?.size) {
    const snapshots = await prisma.stockSnapshot.findMany({
      where: { id: { in: Array.from(stockSnapshotIds) }, businessId },
      select: {
        id: true,
        branch: { select: { name: true } },
        variant: {
          select: { name: true, product: { select: { name: true } } },
        },
      },
    });
    snapshots.forEach((snapshot) => {
      if (!snapshot.variant) {
        return;
      }
      const variantLabel = formatVariantLabel({
        id: snapshot.id,
        name: snapshot.variant.name,
        productName: snapshot.variant.product?.name ?? null,
      });
      const label = snapshot.branch?.name
        ? `${snapshot.branch.name}: ${variantLabel}`
        : variantLabel;
      labels.set(
        toKey('StockSnapshot', snapshot.id),
        labelWithFallback({ name: label, id: snapshot.id }),
      );
    });
  }

  const unitIds = idsByType.get('Unit');
  if (unitIds?.size) {
    const units = await prisma.unit.findMany({
      where: {
        id: { in: Array.from(unitIds) },
        OR: [{ businessId }, { businessId: null }],
      },
      select: { id: true, code: true, label: true },
    });
    units.forEach((unit) => {
      const name = unit.label?.trim()
        ? `${unit.label} (${unit.code})`
        : unit.code;
      labels.set(
        toKey('Unit', unit.id),
        labelWithFallback({ name, id: unit.id }),
      );
    });
  }

  const businessIds = idsByType.get('Business');
  if (businessIds?.size) {
    const businesses = await prisma.business.findMany({
      where: { id: { in: Array.from(businessIds) } },
      select: { id: true, name: true },
    });
    businesses.forEach((business) => {
      labels.set(
        toKey('Business', business.id),
        labelWithFallback({ name: business.name, id: business.id }),
      );
    });
  }

  const businessSettingsIds = idsByType.get('BusinessSettings');
  if (businessSettingsIds?.size) {
    const settings = await prisma.businessSettings.findMany({
      where: { id: { in: Array.from(businessSettingsIds) }, businessId },
      select: { id: true, business: { select: { name: true } } },
    });
    settings.forEach((setting) => {
      const name = setting.business?.name
        ? `${setting.business.name} settings`
        : null;
      labels.set(
        toKey('BusinessSettings', setting.id),
        labelWithFallback({
          name,
          id: setting.id,
          fallback: 'Business settings',
        }),
      );
    });
  }

  const expenseIds = idsByType.get('Expense');
  if (expenseIds?.size) {
    const expenses = await prisma.expense.findMany({
      where: { id: { in: Array.from(expenseIds) }, businessId },
      select: { id: true, category: true, amount: true, currency: true },
    });
    expenses.forEach((expense) => {
      const label = `${expense.category} ${expense.amount} ${expense.currency}`;
      labels.set(
        toKey('Expense', expense.id),
        labelWithFallback({ name: label, id: expense.id }),
      );
    });
  }

  const exportJobIds = idsByType.get('ExportJob');
  if (exportJobIds?.size) {
    const jobs = await prisma.exportJob.findMany({
      where: { id: { in: Array.from(exportJobIds) }, businessId },
      select: { id: true, type: true, status: true },
    });
    jobs.forEach((job) => {
      const label = `${job.type} (${job.status})`;
      labels.set(
        toKey('ExportJob', job.id),
        labelWithFallback({ name: label, id: job.id }),
      );
    });
  }

  const invitationIds = idsByType.get('Invitation');
  if (invitationIds?.size) {
    const invitations = await prisma.invitation.findMany({
      where: { id: { in: Array.from(invitationIds) }, businessId },
      select: { id: true, email: true },
    });
    invitations.forEach((invitation) => {
      labels.set(
        toKey('Invitation', invitation.id),
        labelWithFallback({ name: invitation.email, id: invitation.id }),
      );
    });
  }

  const offlineActionIds = idsByType.get('OfflineAction');
  if (offlineActionIds?.size) {
    const actions = await prisma.offlineAction.findMany({
      where: { id: { in: Array.from(offlineActionIds) }, businessId },
      select: { id: true, actionType: true },
    });
    actions.forEach((action) => {
      labels.set(
        toKey('OfflineAction', action.id),
        labelWithFallback({ name: action.actionType, id: action.id }),
      );
    });
  }

  const offlineDeviceIds = idsByType.get('OfflineDevice');
  if (offlineDeviceIds?.size) {
    const devices = await prisma.offlineDevice.findMany({
      where: { id: { in: Array.from(offlineDeviceIds) }, businessId },
      select: { id: true, deviceName: true },
    });
    devices.forEach((device) => {
      labels.set(
        toKey('OfflineDevice', device.id),
        labelWithFallback({ name: device.deviceName, id: device.id }),
      );
    });
  }

  const permissionIds = idsByType.get('Permission');
  if (permissionIds?.size) {
    const permissions = await prisma.permission.findMany({
      where: { id: { in: Array.from(permissionIds) } },
      select: { id: true, code: true },
    });
    permissions.forEach((permission) => {
      labels.set(
        toKey('Permission', permission.id),
        labelWithFallback({ name: permission.code, id: permission.id }),
      );
    });
  }

  const platformAnnouncementIds = idsByType.get('PlatformAnnouncement');
  if (platformAnnouncementIds?.size) {
    const announcements = await prisma.platformAnnouncement.findMany({
      where: { id: { in: Array.from(platformAnnouncementIds) } },
      select: { id: true, title: true },
    });
    announcements.forEach((announcement) => {
      labels.set(
        toKey('PlatformAnnouncement', announcement.id),
        labelWithFallback({ name: announcement.title, id: announcement.id }),
      );
    });
  }

  const priceListItemIds = idsByType.get('PriceListItem');
  if (priceListItemIds?.size) {
    const items = await prisma.priceListItem.findMany({
      where: {
        id: { in: Array.from(priceListItemIds) },
        priceList: { businessId },
      },
      select: {
        id: true,
        priceList: { select: { name: true } },
        variant: {
          select: { name: true, product: { select: { name: true } } },
        },
      },
    });
    items.forEach((item) => {
      if (!item.priceList || !item.variant) {
        return;
      }
      const label = `${item.priceList.name}: ${formatVariantLabel({
        id: item.id,
        name: item.variant.name,
        productName: item.variant.product?.name ?? null,
      })}`;
      labels.set(
        toKey('PriceListItem', item.id),
        labelWithFallback({ name: label, id: item.id }),
      );
    });
  }

  const purchaseIds = idsByType.get('Purchase');
  if (purchaseIds?.size) {
    const purchases = await prisma.purchase.findMany({
      where: { id: { in: Array.from(purchaseIds) }, businessId },
      select: { id: true, supplier: { select: { name: true } } },
    });
    purchases.forEach((purchase) => {
      if (!purchase.supplier?.name) {
        return;
      }
      labels.set(
        toKey('Purchase', purchase.id),
        labelWithFallback({ name: purchase.supplier.name, id: purchase.id }),
      );
    });
  }

  const purchaseOrderIds = idsByType.get('PurchaseOrder');
  if (purchaseOrderIds?.size) {
    const purchaseOrders = await prisma.purchaseOrder.findMany({
      where: { id: { in: Array.from(purchaseOrderIds) }, businessId },
      select: { id: true, supplier: { select: { name: true } } },
    });
    purchaseOrders.forEach((purchaseOrder) => {
      if (!purchaseOrder.supplier?.name) {
        return;
      }
      labels.set(
        toKey('PurchaseOrder', purchaseOrder.id),
        labelWithFallback({
          name: purchaseOrder.supplier.name,
          id: purchaseOrder.id,
        }),
      );
    });
  }

  const purchasePaymentIds = idsByType.get('PurchasePayment');
  if (purchasePaymentIds?.size) {
    const payments = await prisma.purchasePayment.findMany({
      where: { id: { in: Array.from(purchasePaymentIds) }, businessId },
      select: { id: true, method: true, amount: true },
    });
    payments.forEach((payment) => {
      const label = `${payment.method} ${payment.amount}`;
      labels.set(
        toKey('PurchasePayment', payment.id),
        labelWithFallback({ name: label, id: payment.id }),
      );
    });
  }

  const receiptIds = idsByType.get('Receipt');
  if (receiptIds?.size) {
    const receipts = await prisma.receipt.findMany({
      where: { id: { in: Array.from(receiptIds) } },
      select: {
        id: true,
        receiptNumber: true,
        sale: { select: { businessId: true } },
      },
    });
    receipts.forEach((receipt) => {
      if (receipt.sale?.businessId !== businessId) {
        return;
      }
      labels.set(
        toKey('Receipt', receipt.id),
        labelWithFallback({ name: receipt.receiptNumber, id: receipt.id }),
      );
    });
  }

  const receivingLineIds = idsByType.get('ReceivingLine');
  if (receivingLineIds?.size) {
    const lines = await prisma.receivingLine.findMany({
      where: {
        id: { in: Array.from(receivingLineIds) },
        variant: { businessId },
      },
      select: {
        id: true,
        quantity: true,
        variant: {
          select: { name: true, product: { select: { name: true } } },
        },
      },
    });
    lines.forEach((line) => {
      if (!line.variant) {
        return;
      }
      const label = `${formatVariantLabel({
        id: line.id,
        name: line.variant.name,
        productName: line.variant.product?.name ?? null,
      })} x ${line.quantity}`;
      labels.set(
        toKey('ReceivingLine', line.id),
        labelWithFallback({ name: label, id: line.id }),
      );
    });
  }

  const reorderPointIds = idsByType.get('ReorderPoint');
  if (reorderPointIds?.size) {
    const points = await prisma.reorderPoint.findMany({
      where: { id: { in: Array.from(reorderPointIds) }, businessId },
      select: {
        id: true,
        branch: { select: { name: true } },
        variant: {
          select: { name: true, product: { select: { name: true } } },
        },
      },
    });
    points.forEach((point) => {
      if (!point.variant) {
        return;
      }
      const variantLabel = formatVariantLabel({
        id: point.id,
        name: point.variant.name,
        productName: point.variant.product?.name ?? null,
      });
      const label = point.branch?.name
        ? `${point.branch.name}: ${variantLabel}`
        : variantLabel;
      labels.set(
        toKey('ReorderPoint', point.id),
        labelWithFallback({ name: label, id: point.id }),
      );
    });
  }

  const refreshTokenIds = idsByType.get('RefreshToken');
  if (refreshTokenIds?.size) {
    const tokens = await prisma.refreshToken.findMany({
      where: { id: { in: Array.from(refreshTokenIds) } },
      select: { id: true, user: { select: { name: true, email: true } } },
    });
    tokens.forEach((token) => {
      const label = token.user?.name?.trim() || token.user?.email?.trim();
      labels.set(
        toKey('RefreshToken', token.id),
        labelWithFallback({ name: label, id: token.id }),
      );
    });
  }

  const saleIds = idsByType.get('Sale');
  if (saleIds?.size) {
    const sales = await prisma.sale.findMany({
      where: { id: { in: Array.from(saleIds) }, businessId },
      select: {
        id: true,
        completionKey: true,
        receipt: { select: { receiptNumber: true } },
      },
    });
    sales.forEach((sale) => {
      const label = sale.receipt?.receiptNumber ?? sale.completionKey ?? null;
      labels.set(
        toKey('Sale', sale.id),
        labelWithFallback({ name: label, id: sale.id }),
      );
    });
  }

  const saleRefundIds = idsByType.get('SaleRefund');
  if (saleRefundIds?.size) {
    const refunds = await prisma.saleRefund.findMany({
      where: { id: { in: Array.from(saleRefundIds) }, businessId },
      select: {
        id: true,
        customerNameSnapshot: true,
        sale: { select: { receipt: { select: { receiptNumber: true } } } },
      },
    });
    refunds.forEach((refund) => {
      const label =
        refund.sale?.receipt?.receiptNumber ??
        refund.customerNameSnapshot ??
        null;
      labels.set(
        toKey('SaleRefund', refund.id),
        labelWithFallback({ name: label, id: refund.id }),
      );
    });
  }

  const saleSettlementIds = idsByType.get('SaleSettlement');
  if (saleSettlementIds?.size) {
    const settlements = await prisma.saleSettlement.findMany({
      where: { id: { in: Array.from(saleSettlementIds) }, businessId },
      select: { id: true, method: true, amount: true },
    });
    settlements.forEach((settlement) => {
      const label = `${settlement.method} ${settlement.amount}`;
      labels.set(
        toKey('SaleSettlement', settlement.id),
        labelWithFallback({ name: label, id: settlement.id }),
      );
    });
  }

  const shiftIds = idsByType.get('Shift');
  if (shiftIds?.size) {
    const shifts = await prisma.shift.findMany({
      where: { id: { in: Array.from(shiftIds) }, businessId },
      select: { id: true, branch: { select: { name: true } } },
    });
    shifts.forEach((shift) => {
      const label = shift.branch?.name ? `Shift ${shift.branch.name}` : null;
      labels.set(
        toKey('Shift', shift.id),
        labelWithFallback({ name: label, id: shift.id }),
      );
    });
  }

  const subscriptionIds = idsByType.get('Subscription');
  if (subscriptionIds?.size) {
    const subscriptions = await prisma.subscription.findMany({
      where: { id: { in: Array.from(subscriptionIds) }, businessId },
      select: { id: true, tier: true, status: true },
    });
    subscriptions.forEach((subscription) => {
      const label = `${subscription.tier} (${subscription.status})`;
      labels.set(
        toKey('Subscription', subscription.id),
        labelWithFallback({ name: label, id: subscription.id }),
      );
    });
  }

  const subscriptionRequestIds = idsByType.get('SubscriptionRequest');
  if (subscriptionRequestIds?.size) {
    const requests = await prisma.subscriptionRequest.findMany({
      where: { id: { in: Array.from(subscriptionRequestIds) }, businessId },
      select: { id: true, type: true, requestedTier: true },
    });
    requests.forEach((request) => {
      const label = request.requestedTier
        ? `${request.type} ${request.requestedTier}`
        : request.type;
      labels.set(
        toKey('SubscriptionRequest', request.id),
        labelWithFallback({ name: label, id: request.id }),
      );
    });
  }

  const supportAccessRequestIds = idsByType.get('SupportAccessRequest');
  if (supportAccessRequestIds?.size) {
    const requests = await prisma.supportAccessRequest.findMany({
      where: { id: { in: Array.from(supportAccessRequestIds) }, businessId },
      select: { id: true, business: { select: { name: true } }, status: true },
    });
    requests.forEach((request) => {
      const label = request.business?.name
        ? `${request.business.name} (${request.status})`
        : request.status;
      labels.set(
        toKey('SupportAccessRequest', request.id),
        labelWithFallback({ name: label, id: request.id }),
      );
    });
  }

  const supplierReturnIds = idsByType.get('SupplierReturn');
  if (supplierReturnIds?.size) {
    const supplierReturns = await prisma.supplierReturn.findMany({
      where: { id: { in: Array.from(supplierReturnIds) }, businessId },
      select: { id: true, supplier: { select: { name: true } } },
    });
    supplierReturns.forEach((supplierReturn) => {
      if (!supplierReturn.supplier?.name) {
        return;
      }
      labels.set(
        toKey('SupplierReturn', supplierReturn.id),
        labelWithFallback({
          name: supplierReturn.supplier.name,
          id: supplierReturn.id,
        }),
      );
    });
  }

  const transferIds = idsByType.get('Transfer');
  if (transferIds?.size) {
    const transfers = await prisma.transfer.findMany({
      where: { id: { in: Array.from(transferIds) }, businessId },
      select: {
        id: true,
        sourceBranch: { select: { name: true } },
        destinationBranch: { select: { name: true } },
      },
    });
    transfers.forEach((transfer) => {
      const source = transfer.sourceBranch?.name?.trim();
      const destination = transfer.destinationBranch?.name?.trim();
      const label =
        source && destination
          ? `${source} -> ${destination}`
          : (source ?? destination ?? null);
      labels.set(
        toKey('Transfer', transfer.id),
        labelWithFallback({ name: label, id: transfer.id }),
      );
    });
  }

  const userRoleIds = idsByType.get('UserRole');
  if (userRoleIds?.size) {
    const userRoles = await prisma.userRole.findMany({
      where: { id: { in: Array.from(userRoleIds) }, role: { businessId } },
      select: {
        id: true,
        user: { select: { name: true, email: true } },
        role: { select: { name: true } },
        branch: { select: { name: true } },
      },
    });
    userRoles.forEach((userRole) => {
      const userLabel =
        userRole.user?.name?.trim() || userRole.user?.email?.trim();
      const roleLabel = userRole.role?.name?.trim();
      const branchLabel = userRole.branch?.name?.trim();
      const label = [userLabel, roleLabel, branchLabel]
        .filter(Boolean)
        .join(' - ');
      labels.set(
        toKey('UserRole', userRole.id),
        labelWithFallback({ name: label, id: userRole.id }),
      );
    });
  }

  return labels;
}
