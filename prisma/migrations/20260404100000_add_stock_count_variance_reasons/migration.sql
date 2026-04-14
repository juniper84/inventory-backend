-- Create ShortageReason and SurplusReason enums
CREATE TYPE "ShortageReason" AS ENUM ('DAMAGED', 'LOST', 'STOLEN', 'EXPIRED', 'SHRINKAGE', 'SOLD_OUTSIDE_POS', 'CORRECTION', 'OTHER');
CREATE TYPE "SurplusReason" AS ENUM ('UNRECORDED_PURCHASE', 'FOUND_STOCK', 'RETURN_NOT_LOGGED', 'CORRECTION', 'OTHER');

-- Add reason columns to StockCountVarianceCost
ALTER TABLE "StockCountVarianceCost" ADD COLUMN "shortageReason" "ShortageReason";
ALTER TABLE "StockCountVarianceCost" ADD COLUMN "surplusReason" "SurplusReason";
