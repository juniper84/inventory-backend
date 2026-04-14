-- Create ExpenseCategoryConfig table
CREATE TABLE "ExpenseCategoryConfig" (
    "id" TEXT NOT NULL,
    "businessId" TEXT,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseCategoryConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExpenseCategoryConfig_businessId_code_key" ON "ExpenseCategoryConfig"("businessId", "code");
CREATE INDEX "ExpenseCategoryConfig_businessId_idx" ON "ExpenseCategoryConfig"("businessId");

ALTER TABLE "ExpenseCategoryConfig" ADD CONSTRAINT "ExpenseCategoryConfig_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add title field to Expense
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "title" TEXT;

-- Convert Expense.category from enum to text
-- Step 1: Add temporary text column
ALTER TABLE "Expense" ADD COLUMN "category_text" TEXT;

-- Step 2: Copy values as text
UPDATE "Expense" SET "category_text" = "category"::TEXT;

-- Step 3: Drop old column and rename
ALTER TABLE "Expense" DROP COLUMN "category";
ALTER TABLE "Expense" RENAME COLUMN "category_text" TO "category";
ALTER TABLE "Expense" ALTER COLUMN "category" SET DEFAULT 'GENERAL';

-- Step 4: Recreate index
CREATE INDEX IF NOT EXISTS "Expense_businessId_category_createdAt_idx" ON "Expense"("businessId", "category", "createdAt");

-- Step 5: Drop the old enum (after all references removed)
DROP TYPE IF EXISTS "ExpenseCategory";

-- Seed system default categories
INSERT INTO "ExpenseCategoryConfig" ("id", "businessId", "code", "label", "isSystem", "createdAt") VALUES
  (gen_random_uuid()::text, NULL, 'GENERAL', 'General', true, NOW()),
  (gen_random_uuid()::text, NULL, 'TRANSFER_FEE', 'Transfer Fee', true, NOW()),
  (gen_random_uuid()::text, NULL, 'SHIPPING', 'Shipping', true, NOW()),
  (gen_random_uuid()::text, NULL, 'UTILITIES', 'Utilities', true, NOW()),
  (gen_random_uuid()::text, NULL, 'RENT', 'Rent', true, NOW()),
  (gen_random_uuid()::text, NULL, 'PAYROLL', 'Payroll', true, NOW()),
  (gen_random_uuid()::text, NULL, 'STOCK_COST', 'Stock Purchase Cost', true, NOW()),
  (gen_random_uuid()::text, NULL, 'OTHER', 'Other', true, NOW())
ON CONFLICT DO NOTHING;
