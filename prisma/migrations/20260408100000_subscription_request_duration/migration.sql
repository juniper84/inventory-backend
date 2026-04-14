-- AlterEnum
ALTER TYPE "SubscriptionRequestType" ADD VALUE 'SUBSCRIBE';

-- AlterTable
ALTER TABLE "SubscriptionRequest" ADD COLUMN "requestedDurationMonths" INTEGER;
ALTER TABLE "SubscriptionRequest" ADD COLUMN "approvedDurationMonths" INTEGER;
ALTER TABLE "SubscriptionRequest" ADD COLUMN "approvedTier" TEXT;
ALTER TABLE "SubscriptionRequest" ADD COLUMN "isPaid" BOOLEAN;
ALTER TABLE "SubscriptionRequest" ADD COLUMN "amountDue" DOUBLE PRECISION;
