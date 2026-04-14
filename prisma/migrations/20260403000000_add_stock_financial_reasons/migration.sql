-- Add new values to LossReason enum
ALTER TYPE "LossReason" ADD VALUE IF NOT EXISTS 'SOLD_OUTSIDE_POS';
ALTER TYPE "LossReason" ADD VALUE IF NOT EXISTS 'CORRECTION';

-- Add new values to GainReason enum
ALTER TYPE "GainReason" ADD VALUE IF NOT EXISTS 'INITIAL_STOCK';

-- Add CORRECTION to GainReason (already exists, this is a no-op guard)
-- GainReason.CORRECTION already existed in the original enum

-- Add new value to ExpenseCategory enum
ALTER TYPE "ExpenseCategory" ADD VALUE IF NOT EXISTS 'STOCK_COST';
