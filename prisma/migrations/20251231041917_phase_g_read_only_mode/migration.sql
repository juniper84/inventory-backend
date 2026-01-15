-- AlterTable
ALTER TABLE "BusinessSettings" ADD COLUMN     "readOnlyEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "readOnlyEnabledAt" TIMESTAMP(3),
ADD COLUMN     "readOnlyReason" TEXT;
