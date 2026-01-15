-- Phase C add-ons: customers, credit, shifts, price lists, returns without receipt

-- CreateEnum
CREATE TYPE "SaleType" AS ENUM ('SALE', 'RETURN_ONLY');
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterTable
ALTER TABLE "Branch" ADD COLUMN "priceListId" TEXT;

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "tin" TEXT,
    "notes" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "priceListId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PriceList" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceList_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PriceListItem" (
    "id" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceListItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "openedById" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openingCash" DECIMAL(12,2) NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "closingCash" DECIMAL(12,2),
    "variance" DECIMAL(12,2),
    "varianceReason" TEXT,
    "notes" TEXT,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SaleSettlement" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "methodLabel" TEXT,
    "reference" TEXT,
    "receivedById" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaleSettlement_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Sale"
ADD COLUMN "customerId" TEXT,
ADD COLUMN "shiftId" TEXT,
ADD COLUMN "saleType" "SaleType" NOT NULL DEFAULT 'SALE',
ADD COLUMN "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN "outstandingAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN "creditDueDate" TIMESTAMP(3),
ADD COLUMN "customerNameSnapshot" TEXT,
ADD COLUMN "customerPhoneSnapshot" TEXT,
ADD COLUMN "customerEmailSnapshot" TEXT,
ADD COLUMN "customerTinSnapshot" TEXT;

-- AlterTable
ALTER TABLE "SaleRefund" ALTER COLUMN "saleId" DROP NOT NULL;
ALTER TABLE "SaleRefund"
ADD COLUMN "customerId" TEXT,
ADD COLUMN "isReturnOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "customerNameSnapshot" TEXT,
ADD COLUMN "customerPhoneSnapshot" TEXT,
ADD COLUMN "customerTinSnapshot" TEXT;

-- Indexes
CREATE INDEX "Customer_businessId_status_idx" ON "Customer"("businessId", "status");
CREATE INDEX "Customer_businessId_phone_idx" ON "Customer"("businessId", "phone");
CREATE INDEX "Customer_businessId_email_idx" ON "Customer"("businessId", "email");

CREATE UNIQUE INDEX "Customer_businessId_phone_key" ON "Customer"("businessId", "phone");
CREATE UNIQUE INDEX "Customer_businessId_email_key" ON "Customer"("businessId", "email");

CREATE UNIQUE INDEX "PriceList_businessId_name_key" ON "PriceList"("businessId", "name");
CREATE UNIQUE INDEX "PriceListItem_priceListId_variantId_key"
ON "PriceListItem"("priceListId", "variantId");

CREATE INDEX "Shift_businessId_branchId_status_idx"
ON "Shift"("businessId", "branchId", "status");

CREATE INDEX "SaleSettlement_businessId_saleId_idx"
ON "SaleSettlement"("businessId", "saleId");

-- Foreign Keys
ALTER TABLE "Branch"
ADD CONSTRAINT "Branch_priceListId_fkey"
FOREIGN KEY ("priceListId") REFERENCES "PriceList"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Customer"
ADD CONSTRAINT "Customer_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Customer"
ADD CONSTRAINT "Customer_priceListId_fkey"
FOREIGN KEY ("priceListId") REFERENCES "PriceList"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PriceList"
ADD CONSTRAINT "PriceList_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PriceListItem"
ADD CONSTRAINT "PriceListItem_priceListId_fkey"
FOREIGN KEY ("priceListId") REFERENCES "PriceList"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PriceListItem"
ADD CONSTRAINT "PriceListItem_variantId_fkey"
FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Shift"
ADD CONSTRAINT "Shift_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Shift"
ADD CONSTRAINT "Shift_branchId_fkey"
FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Shift"
ADD CONSTRAINT "Shift_openedById_fkey"
FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Shift"
ADD CONSTRAINT "Shift_closedById_fkey"
FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Sale"
ADD CONSTRAINT "Sale_customerId_fkey"
FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Sale"
ADD CONSTRAINT "Sale_shiftId_fkey"
FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SaleRefund"
ADD CONSTRAINT "SaleRefund_customerId_fkey"
FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SaleSettlement"
ADD CONSTRAINT "SaleSettlement_saleId_fkey"
FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SaleSettlement"
ADD CONSTRAINT "SaleSettlement_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SaleSettlement"
ADD CONSTRAINT "SaleSettlement_receivedById_fkey"
FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
