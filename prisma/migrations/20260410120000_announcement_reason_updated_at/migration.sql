-- AlterTable
ALTER TABLE "PlatformAnnouncement" ADD COLUMN "reason" TEXT;
ALTER TABLE "PlatformAnnouncement" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
