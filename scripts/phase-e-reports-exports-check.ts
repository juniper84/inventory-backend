import fs from 'fs';
import path from 'path';
import { ExportJobType, Prisma, SubscriptionStatus, SubscriptionTier } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { AuditContextStore } from '../src/audit/audit-context';
import { ExportsService } from '../src/exports/exports.service';
import { ImportsService } from '../src/imports/imports.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { ReportsService } from '../src/reports/reports.service';
import { StorageService } from '../src/storage/storage.service';
import { hashPassword } from '../src/auth/password';
import {
  DEFAULT_APPROVAL_DEFAULTS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_LOCALE_SETTINGS,
  DEFAULT_POS_POLICIES,
  DEFAULT_STOCK_POLICIES,
} from '../src/settings/defaults';

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const idx = trimmed.indexOf('=');
    if (idx === -1) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertExists<T>(value: T | null | undefined, message: string): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
}

async function main() {
  loadEnv();
  const prisma = new PrismaService();
  const auditService = new AuditService(prisma, new AuditContextStore());
  const notificationsService = new NotificationsService(prisma, auditService);
  const configService = new ConfigService();
  const storageService = new StorageService(configService);
  const reportsService = new ReportsService(prisma, auditService, notificationsService);
  const exportsService = new ExportsService(
    prisma,
    auditService,
    storageService,
    configService,
  );
  const importsService = new ImportsService(prisma, auditService);

  const suffix = Date.now();
  const business = await prisma.business.create({
    data: {
      name: `Phase E Reports Test ${suffix}`,
      status: 'TRIAL',
      defaultLanguage: 'en',
    },
  });

  await prisma.businessSettings.create({
    data: {
      businessId: business.id,
      approvalDefaults: DEFAULT_APPROVAL_DEFAULTS as Prisma.InputJsonValue,
      notificationDefaults:
        DEFAULT_NOTIFICATION_SETTINGS as Prisma.InputJsonValue,
      stockPolicies: DEFAULT_STOCK_POLICIES as Prisma.InputJsonValue,
      posPolicies: DEFAULT_POS_POLICIES as Prisma.InputJsonValue,
      localeSettings: DEFAULT_LOCALE_SETTINGS as Prisma.InputJsonValue,
    },
  });

  await prisma.subscription.create({
    data: {
      businessId: business.id,
      tier: SubscriptionTier.BUSINESS,
      status: SubscriptionStatus.TRIAL,
      trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      limits: {
        users: 10,
        branches: 5,
        products: 5000,
        monthlyTransactions: 5000,
        offline: true,
        offlineDevices: 3,
        storageGb: 5,
      },
    },
  });

  const user = await prisma.user.create({
    data: {
      name: 'Phase E Tester',
      email: `phasee+${suffix}@local.test`,
      passwordHash: hashPassword('TestPass123'),
      status: 'ACTIVE',
    },
  });

  await prisma.businessUser.create({
    data: {
      businessId: business.id,
      userId: user.id,
      status: 'ACTIVE',
    },
  });

  const branch = await prisma.branch.create({
    data: {
      businessId: business.id,
      name: 'Phase E Branch',
      status: 'ACTIVE',
    },
  });

  const role = await prisma.role.create({
    data: { businessId: business.id, name: 'Phase E Role' },
  });

  const categoriesCsv = `name,status,parent
Beverages,Active,
Soft Drinks,Active,Beverages
`;
  const categoriesPreview = await importsService.preview(business.id, {
    type: 'categories',
    csv: categoriesCsv,
  });
  assert(categoriesPreview.invalidRows === 0, 'Category preview failed.');
  await importsService.apply(business.id, user.id, {
    type: 'categories',
    csv: categoriesCsv,
  });

  const branchesCsv = `name,status,address,phone
Phase E Import Branch,Active,Market Rd,255700000001
`;
  await importsService.apply(business.id, user.id, {
    type: 'branches',
    csv: branchesCsv,
  });
  const importBranch = await prisma.branch.findFirst({
    where: { businessId: business.id, name: 'Phase E Import Branch' },
  });
  assertExists(importBranch, 'Branch import failed.');

  const suppliersCsv = `name,status,phone,email,address,notes
Phase E Supplier,Active,255700000002,phasee-supplier@local.test,Warehouse,Test supplier
`;
  await importsService.apply(business.id, user.id, {
    type: 'suppliers',
    csv: suppliersCsv,
  });

  const productsCsv = `name,category,status,description,sku,barcode,price,cost,vat_mode
Phase E Soda,Soft Drinks,Active,Test product,PHASEE-SKU,PHASEE-BC,120,60,Inclusive
`;
  await importsService.apply(business.id, user.id, {
    type: 'products',
    csv: productsCsv,
  });
  const variant = await prisma.variant.findFirst({
    where: { businessId: business.id, name: 'Phase E Soda' },
  });
  assertExists(variant, 'Product import failed to create variant.');
  const variantId = variant.id;
  const importBranchId = importBranch.id;

  const openingStockCsv = `variant_id,branch_id,quantity,batch_id,expiry_date,unit_cost
${variantId},${importBranchId},2,PHASEE-BATCH,${new Date(
    Date.now() + 3 * 24 * 60 * 60 * 1000,
  ).toISOString()},55
`;
  await importsService.apply(business.id, user.id, {
    type: 'opening_stock',
    csv: openingStockCsv,
  });

  const priceUpdatesCsv = `variant_id,price,vat_mode
${variantId},150,Inclusive
`;
  await importsService.apply(business.id, user.id, {
    type: 'price_updates',
    csv: priceUpdatesCsv,
  });

  const statusUpdatesCsv = `product_name,variant_name,status
Phase E Soda,,Active
`;
  await importsService.apply(business.id, user.id, {
    type: 'status_updates',
    csv: statusUpdatesCsv,
  });

  const usersCsv = `name,email,role,status,branch_ids
Phase E User,phasee.user@local.test,${role.name},Active,${importBranchId}
`;
  await importsService.apply(business.id, user.id, {
    type: 'users',
    csv: usersCsv,
  });

  const customer = await prisma.customer.create({
    data: {
      businessId: business.id,
      name: 'Phase E Customer',
      phone: '255700000003',
      email: 'phasee.customer@local.test',
      tin: 'TIN-123456',
      status: 'ACTIVE',
    },
  });

  const sale = await prisma.sale.create({
    data: {
      businessId: business.id,
      branchId: branch.id,
      cashierId: user.id,
      customerId: customer.id,
      status: 'COMPLETED',
      saleType: 'SALE',
      subtotal: new Prisma.Decimal(100),
      cartDiscount: new Prisma.Decimal(0),
      discountTotal: new Prisma.Decimal(0),
      vatTotal: new Prisma.Decimal(0),
      total: new Prisma.Decimal(100),
      paidAmount: new Prisma.Decimal(50),
      outstandingAmount: new Prisma.Decimal(50),
      creditDueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      customerNameSnapshot: customer.name,
      customerPhoneSnapshot: customer.phone,
      customerEmailSnapshot: customer.email,
      customerTinSnapshot: customer.tin,
    },
  });

  await prisma.saleLine.create({
    data: {
      saleId: sale.id,
      variantId,
      productName: 'Phase E Soda',
      variantName: 'Phase E Soda',
      skuSnapshot: 'PHASEE-SKU',
      barcodeSnapshot: 'PHASEE-BC',
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(100),
      vatMode: 'INCLUSIVE',
      vatRate: new Prisma.Decimal(0),
      vatAmount: new Prisma.Decimal(0),
      lineTotal: new Prisma.Decimal(100),
      lineDiscount: new Prisma.Decimal(0),
    },
  });

  const refund = await prisma.saleRefund.create({
    data: {
      businessId: business.id,
      branchId: branch.id,
      cashierId: user.id,
      customerId: customer.id,
      status: 'COMPLETED',
      total: new Prisma.Decimal(20),
      saleId: sale.id,
      customerNameSnapshot: customer.name,
      customerPhoneSnapshot: customer.phone,
      customerTinSnapshot: customer.tin,
    },
  });

  await prisma.saleRefundLine.create({
    data: {
      refundId: refund.id,
      variantId,
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(20),
      vatAmount: new Prisma.Decimal(0),
      lineTotal: new Prisma.Decimal(20),
    },
  });

  const stock = await reportsService.stockReport(business.id, user.id, {});
  assert(stock.length > 0, 'Stock report returned no rows.');
  const sales = await reportsService.salesReport(business.id, user.id, {});
  assert(sales.length > 0, 'Sales report returned no rows.');
  const vat = await reportsService.vatReport(business.id, user.id, {});
  assert(vat.length > 0, 'VAT report returned no rows.');
  const pnl = await reportsService.pnlReport(business.id, user.id, {});
  assert(pnl.totals.revenue > 0, 'P&L report totals missing.');
  const lowStock = await reportsService.lowStockReport(business.id, user.id, {
    threshold: '5',
  });
  assert(lowStock.length > 0, 'Low-stock report returned no rows.');
  const expiry = await reportsService.expiryReport(business.id, user.id, { days: '10' });
  assert(expiry.length > 0, 'Expiry report returned no rows.');
  const staff = await reportsService.staffPerformance(business.id, user.id);
  assert(staff.length > 0, 'Staff performance report returned no rows.');
  const customerSales = await reportsService.customerSalesReport(business.id, user.id);
  assert(customerSales.length > 0, 'Customer sales report returned no rows.');
  const customerRefunds = await reportsService.customerRefundsReport(business.id, user.id);
  assert(customerRefunds.length > 0, 'Customer refunds report returned no rows.');
  const outstanding = await reportsService.customerOutstandingReport(
    business.id,
    user.id,
  );
  assert(outstanding.length > 0, 'Customer outstanding report returned no rows.');
  const topCustomers = await reportsService.topCustomersReport(business.id, user.id);
  assert(topCustomers.length > 0, 'Top customers report returned no rows.');
  const customerCsv = await reportsService.customerReportsCsv(business.id, user.id);
  assert(customerCsv.includes('customerName'), 'Customer CSV missing header.');

  const exportProducts = await exportsService.createExportJob(business.id, user.id, {
    type: 'PRODUCTS' as ExportJobType,
  });
  const exportBranches = await exportsService.createExportJob(business.id, user.id, {
    type: 'BRANCHES' as ExportJobType,
  });
  const exportUsers = await exportsService.createExportJob(business.id, user.id, {
    type: 'USERS' as ExportJobType,
  });
  const exportAudit = await exportsService.createExportJob(business.id, user.id, {
    type: 'AUDIT_LOGS' as ExportJobType,
    acknowledgement: 'YES',
  });
  const exportOnExit = await exportsService.createExportJob(business.id, user.id, {
    type: 'EXPORT_ON_EXIT' as ExportJobType,
  });
  const exportProductsRun = await exportsService.runExportJob(exportProducts.id);
  const exportBranchesRun = await exportsService.runExportJob(exportBranches.id);
  const exportUsersRun = await exportsService.runExportJob(exportUsers.id);
  const exportAuditRun = await exportsService.runExportJob(exportAudit.id, 'YES');
  const exportOnExitRun = await exportsService.runExportJob(exportOnExit.id);
  assert(exportProductsRun?.status === 'COMPLETED', `Products export failed: ${exportProductsRun?.lastError ?? 'unknown error'}`);
  assert(exportBranchesRun?.status === 'COMPLETED', `Branches export failed: ${exportBranchesRun?.lastError ?? 'unknown error'}`);
  assert(exportUsersRun?.status === 'COMPLETED', `Users export failed: ${exportUsersRun?.lastError ?? 'unknown error'}`);
  assert(exportAuditRun?.status === 'COMPLETED', `Audit export failed: ${exportAuditRun?.lastError ?? 'unknown error'}`);
  assert(exportOnExitRun?.status === 'COMPLETED', `Export-on-exit failed: ${exportOnExitRun?.lastError ?? 'unknown error'}`);

  const productsMeta = exportProductsRun?.metadata as { csv?: string } | null;
  const branchesMeta = exportBranchesRun?.metadata as { csv?: string } | null;
  const usersMeta = exportUsersRun?.metadata as { csv?: string } | null;
  const auditMeta = exportAuditRun?.metadata as { csv?: string } | null;
  const exportOnExitMeta = exportOnExitRun?.metadata as { files?: unknown } | null;
  assert(productsMeta?.csv, 'Products export missing CSV.');
  assert(branchesMeta?.csv, 'Branches export missing CSV.');
  assert(usersMeta?.csv, 'Users export missing CSV.');
  assert(auditMeta?.csv, 'Audit log export missing CSV.');
  assert(exportOnExitMeta?.files, 'Export-on-exit missing file bundle.');

  console.log('\nPhase E reports & exports check results');
  console.log('Business:', business.id);
  console.log('Branch:', branch.id);
  console.log('Product variant:', variantId);
  console.log('Sale:', sale.id);
  console.log('Refund:', refund.id);
  console.log('PASS: Phase E checks OK');
  console.log('Note: Test data remains in the database.');

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
