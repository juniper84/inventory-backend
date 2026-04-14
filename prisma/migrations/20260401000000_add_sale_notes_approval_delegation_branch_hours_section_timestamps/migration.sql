-- AlterTable
ALTER TABLE "Sale" ADD COLUMN "notes" TEXT;

-- AlterTable
ALTER TABLE "Approval" ADD COLUMN "delegatedToUserId" TEXT;

-- AlterTable
ALTER TABLE "Branch" ADD COLUMN "openingTime" TEXT;
ALTER TABLE "Branch" ADD COLUMN "closingTime" TEXT;

-- AlterTable
ALTER TABLE "BusinessSettings" ADD COLUMN "sectionUpdatedAt" JSONB;
