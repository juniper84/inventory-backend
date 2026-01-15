-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ExportJobType" ADD VALUE 'STOCK';
ALTER TYPE "ExportJobType" ADD VALUE 'PRODUCTS';
ALTER TYPE "ExportJobType" ADD VALUE 'OPENING_STOCK';
ALTER TYPE "ExportJobType" ADD VALUE 'PRICE_UPDATES';
ALTER TYPE "ExportJobType" ADD VALUE 'SUPPLIERS';
ALTER TYPE "ExportJobType" ADD VALUE 'BRANCHES';
ALTER TYPE "ExportJobType" ADD VALUE 'USERS';
ALTER TYPE "ExportJobType" ADD VALUE 'AUDIT_LOGS';
ALTER TYPE "ExportJobType" ADD VALUE 'CUSTOMER_REPORTS';
