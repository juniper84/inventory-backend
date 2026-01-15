-- CreateEnum
CREATE TYPE "UnitType" AS ENUM ('COUNT', 'WEIGHT', 'VOLUME', 'LENGTH', 'OTHER');

-- CreateTable
CREATE TABLE "Unit" (
    "id" TEXT NOT NULL,
    "businessId" TEXT,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "unitType" "UnitType" NOT NULL DEFAULT 'COUNT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Unit_businessId_code_key" ON "Unit"("businessId", "code");

-- CreateIndex
CREATE INDEX "Unit_businessId_idx" ON "Unit"("businessId");

-- AlterTable
ALTER TABLE "Variant" ADD COLUMN     "baseUnitId" TEXT,
ADD COLUMN     "sellUnitId" TEXT,
ADD COLUMN     "conversionFactor" DECIMAL(12,4) DEFAULT 1;

-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "unitId" TEXT,
ADD COLUMN     "unitFactor" DECIMAL(12,4) DEFAULT 1;

-- AlterTable
ALTER TABLE "SaleRefundLine" ADD COLUMN     "unitId" TEXT,
ADD COLUMN     "unitFactor" DECIMAL(12,4) DEFAULT 1;

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "unitId" TEXT,
ADD COLUMN     "unitQuantity" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "PurchaseLine" ADD COLUMN     "unitId" TEXT,
ADD COLUMN     "unitFactor" DECIMAL(12,4) DEFAULT 1;

-- AlterTable
ALTER TABLE "PurchaseOrderLine" ADD COLUMN     "unitId" TEXT,
ADD COLUMN     "unitFactor" DECIMAL(12,4) DEFAULT 1;

-- AlterTable
ALTER TABLE "ReceivingLine" ADD COLUMN     "unitId" TEXT,
ADD COLUMN     "unitFactor" DECIMAL(12,4) DEFAULT 1;

-- AlterTable
ALTER TABLE "SupplierReturnLine" ADD COLUMN     "unitId" TEXT,
ADD COLUMN     "unitFactor" DECIMAL(12,4) DEFAULT 1;

-- CreateIndex
CREATE INDEX "Variant_baseUnitId_idx" ON "Variant"("baseUnitId");

-- CreateIndex
CREATE INDEX "Variant_sellUnitId_idx" ON "Variant"("sellUnitId");

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_baseUnitId_fkey" FOREIGN KEY ("baseUnitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_sellUnitId_fkey" FOREIGN KEY ("sellUnitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleRefundLine" ADD CONSTRAINT "SaleRefundLine_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseLine" ADD CONSTRAINT "PurchaseLine_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivingLine" ADD CONSTRAINT "ReceivingLine_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierReturnLine" ADD CONSTRAINT "SupplierReturnLine_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed default units
INSERT INTO "Unit" ("id", "businessId", "code", "label", "unitType", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), NULL, 'piece', 'Piece', 'COUNT', NOW(), NOW()),
  (gen_random_uuid(), NULL, 'box', 'Box', 'COUNT', NOW(), NOW()),
  (gen_random_uuid(), NULL, 'pack', 'Pack', 'COUNT', NOW(), NOW()),
  (gen_random_uuid(), NULL, 'case', 'Case', 'COUNT', NOW(), NOW()),
  (gen_random_uuid(), NULL, 'kg', 'Kilogram', 'WEIGHT', NOW(), NOW()),
  (gen_random_uuid(), NULL, 'g', 'Gram', 'WEIGHT', NOW(), NOW()),
  (gen_random_uuid(), NULL, 'litre', 'Litre', 'VOLUME', NOW(), NOW()),
  (gen_random_uuid(), NULL, 'ml', 'Millilitre', 'VOLUME', NOW(), NOW())
ON CONFLICT ("businessId", "code") DO NOTHING;

DO $$
DECLARE
  piece_id TEXT;
BEGIN
  SELECT id INTO piece_id
  FROM "Unit"
  WHERE "businessId" IS NULL AND "code" = 'piece'
  LIMIT 1;

  IF piece_id IS NOT NULL THEN
    UPDATE "Variant"
    SET "baseUnitId" = piece_id,
        "sellUnitId" = piece_id,
        "conversionFactor" = COALESCE("conversionFactor", 1)
    WHERE "baseUnitId" IS NULL
       OR "sellUnitId" IS NULL;
  END IF;
END $$;
