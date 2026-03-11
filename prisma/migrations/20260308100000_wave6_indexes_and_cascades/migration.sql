-- Wave 6: Missing indexes and cascade deletes
-- Cascade deletes fix FK constraint errors when deleting roles/users.

-- ============================================================
-- CASCADE DELETES
-- ============================================================

-- UserRole: cascade when role or user is deleted
ALTER TABLE "UserRole" DROP CONSTRAINT "UserRole_roleId_fkey";
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserRole" DROP CONSTRAINT "UserRole_userId_fkey";
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RolePermission: cascade when role is deleted
ALTER TABLE "RolePermission" DROP CONSTRAINT "RolePermission_roleId_fkey";
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Invitation: cascade when role is deleted
ALTER TABLE "Invitation" DROP CONSTRAINT "Invitation_roleId_fkey";
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- INDEXES
-- ============================================================

-- Role
CREATE INDEX IF NOT EXISTS "Role_businessId_idx"
  ON "Role"("businessId");

-- Category
CREATE INDEX IF NOT EXISTS "Category_businessId_idx"
  ON "Category"("businessId");
CREATE INDEX IF NOT EXISTS "Category_businessId_name_idx"
  ON "Category"("businessId", "name");

-- Product
CREATE INDEX IF NOT EXISTS "Product_businessId_idx"
  ON "Product"("businessId");
CREATE INDEX IF NOT EXISTS "Product_businessId_name_idx"
  ON "Product"("businessId", "name");

-- StockMovement
CREATE INDEX IF NOT EXISTS "StockMovement_businessId_branchId_variantId_idx"
  ON "StockMovement"("businessId", "branchId", "variantId");

-- Transfer
CREATE INDEX IF NOT EXISTS "Transfer_businessId_status_idx"
  ON "Transfer"("businessId", "status");

-- UserRole
CREATE INDEX IF NOT EXISTS "UserRole_roleId_idx"
  ON "UserRole"("roleId");

-- SaleLine
CREATE INDEX IF NOT EXISTS "SaleLine_saleId_idx"
  ON "SaleLine"("saleId");

-- SalePayment
CREATE INDEX IF NOT EXISTS "SalePayment_saleId_idx"
  ON "SalePayment"("saleId");

-- SaleRefund
CREATE INDEX IF NOT EXISTS "SaleRefund_businessId_status_idx"
  ON "SaleRefund"("businessId", "status");

-- SaleRefundLine
CREATE INDEX IF NOT EXISTS "SaleRefundLine_refundId_idx"
  ON "SaleRefundLine"("refundId");

-- Purchase
CREATE INDEX IF NOT EXISTS "Purchase_businessId_status_idx"
  ON "Purchase"("businessId", "status");

-- PurchaseLine
CREATE INDEX IF NOT EXISTS "PurchaseLine_purchaseId_idx"
  ON "PurchaseLine"("purchaseId");

-- PurchaseOrder
CREATE INDEX IF NOT EXISTS "PurchaseOrder_businessId_status_idx"
  ON "PurchaseOrder"("businessId", "status");

-- PurchaseOrderLine
CREATE INDEX IF NOT EXISTS "PurchaseOrderLine_purchaseOrderId_idx"
  ON "PurchaseOrderLine"("purchaseOrderId");

-- ReceivingLine
CREATE INDEX IF NOT EXISTS "ReceivingLine_purchaseId_idx"
  ON "ReceivingLine"("purchaseId");
CREATE INDEX IF NOT EXISTS "ReceivingLine_purchaseOrderId_idx"
  ON "ReceivingLine"("purchaseOrderId");

-- Attachment
CREATE INDEX IF NOT EXISTS "Attachment_purchaseId_idx"
  ON "Attachment"("purchaseId");

-- SupplierReturn
CREATE INDEX IF NOT EXISTS "SupplierReturn_businessId_status_idx"
  ON "SupplierReturn"("businessId", "status");

-- ExportJob
CREATE INDEX IF NOT EXISTS "ExportJob_businessId_status_idx"
  ON "ExportJob"("businessId", "status");
