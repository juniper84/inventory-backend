-- Add referenceNumber column to 8 transaction models (IF NOT EXISTS for idempotency)
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "referenceNumber" TEXT;
ALTER TABLE "Purchase" ADD COLUMN IF NOT EXISTS "referenceNumber" TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "referenceNumber" TEXT;
ALTER TABLE "Transfer" ADD COLUMN IF NOT EXISTS "referenceNumber" TEXT;
ALTER TABLE "SupplierReturn" ADD COLUMN IF NOT EXISTS "referenceNumber" TEXT;
ALTER TABLE "Shift" ADD COLUMN IF NOT EXISTS "referenceNumber" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "referenceNumber" TEXT;
ALTER TABLE "Approval" ADD COLUMN IF NOT EXISTS "referenceNumber" TEXT;

-- Backfill existing records with sequential reference numbers per business
-- Sales (ordered by createdAt)
WITH numbered AS (
  SELECT id, "businessId", ROW_NUMBER() OVER (PARTITION BY "businessId" ORDER BY "createdAt") AS rn
  FROM "Sale"
  WHERE "referenceNumber" IS NULL
)
UPDATE "Sale" SET "referenceNumber" = 'SAL-' || LPAD(numbered.rn::text, 3, '0')
FROM numbered WHERE "Sale".id = numbered.id;

-- Purchases (ordered by createdAt)
WITH numbered AS (
  SELECT id, "businessId", ROW_NUMBER() OVER (PARTITION BY "businessId" ORDER BY "createdAt") AS rn
  FROM "Purchase"
  WHERE "referenceNumber" IS NULL
)
UPDATE "Purchase" SET "referenceNumber" = 'PUR-' || LPAD(numbered.rn::text, 3, '0')
FROM numbered WHERE "Purchase".id = numbered.id;

-- Purchase Orders (ordered by createdAt)
WITH numbered AS (
  SELECT id, "businessId", ROW_NUMBER() OVER (PARTITION BY "businessId" ORDER BY "createdAt") AS rn
  FROM "PurchaseOrder"
  WHERE "referenceNumber" IS NULL
)
UPDATE "PurchaseOrder" SET "referenceNumber" = 'PO-' || LPAD(numbered.rn::text, 3, '0')
FROM numbered WHERE "PurchaseOrder".id = numbered.id;

-- Transfers (ordered by createdAt)
WITH numbered AS (
  SELECT id, "businessId", ROW_NUMBER() OVER (PARTITION BY "businessId" ORDER BY "createdAt") AS rn
  FROM "Transfer"
  WHERE "referenceNumber" IS NULL
)
UPDATE "Transfer" SET "referenceNumber" = 'TRF-' || LPAD(numbered.rn::text, 3, '0')
FROM numbered WHERE "Transfer".id = numbered.id;

-- Supplier Returns (ordered by createdAt)
WITH numbered AS (
  SELECT id, "businessId", ROW_NUMBER() OVER (PARTITION BY "businessId" ORDER BY "createdAt") AS rn
  FROM "SupplierReturn"
  WHERE "referenceNumber" IS NULL
)
UPDATE "SupplierReturn" SET "referenceNumber" = 'RET-' || LPAD(numbered.rn::text, 3, '0')
FROM numbered WHERE "SupplierReturn".id = numbered.id;

-- Shifts (ordered by openedAt — this model uses openedAt, not createdAt)
WITH numbered AS (
  SELECT id, "businessId", ROW_NUMBER() OVER (PARTITION BY "businessId" ORDER BY "openedAt") AS rn
  FROM "Shift"
  WHERE "referenceNumber" IS NULL
)
UPDATE "Shift" SET "referenceNumber" = 'SHF-' || LPAD(numbered.rn::text, 3, '0')
FROM numbered WHERE "Shift".id = numbered.id;

-- Expenses (ordered by createdAt)
WITH numbered AS (
  SELECT id, "businessId", ROW_NUMBER() OVER (PARTITION BY "businessId" ORDER BY "createdAt") AS rn
  FROM "Expense"
  WHERE "referenceNumber" IS NULL
)
UPDATE "Expense" SET "referenceNumber" = 'EXP-' || LPAD(numbered.rn::text, 3, '0')
FROM numbered WHERE "Expense".id = numbered.id;

-- Approvals (ordered by requestedAt — this model uses requestedAt, not createdAt)
WITH numbered AS (
  SELECT id, "businessId", ROW_NUMBER() OVER (PARTITION BY "businessId" ORDER BY "requestedAt") AS rn
  FROM "Approval"
  WHERE "referenceNumber" IS NULL
)
UPDATE "Approval" SET "referenceNumber" = 'APR-' || LPAD(numbered.rn::text, 3, '0')
FROM numbered WHERE "Approval".id = numbered.id;
