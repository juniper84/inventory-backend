CREATE TYPE "SubscriptionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "SubscriptionRequestType" AS ENUM ('UPGRADE', 'DOWNGRADE', 'CANCEL');

CREATE TABLE "SubscriptionRequest" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "type" "SubscriptionRequestType" NOT NULL,
  "requestedTier" "SubscriptionTier",
  "status" "SubscriptionRequestStatus" NOT NULL DEFAULT 'PENDING',
  "reason" TEXT,
  "responseNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP(3),
  "decidedByPlatformAdminId" TEXT,

  CONSTRAINT "SubscriptionRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SubscriptionRequest_businessId_status_idx" ON "SubscriptionRequest"("businessId", "status");

ALTER TABLE "SubscriptionRequest"
ADD CONSTRAINT "SubscriptionRequest_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SubscriptionRequest"
ADD CONSTRAINT "SubscriptionRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SubscriptionRequest"
ADD CONSTRAINT "SubscriptionRequest_decidedByPlatformAdminId_fkey" FOREIGN KEY ("decidedByPlatformAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE SET NULL ON UPDATE CASCADE;
