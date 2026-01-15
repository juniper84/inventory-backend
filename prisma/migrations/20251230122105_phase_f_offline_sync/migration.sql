/*
  Warnings:

  - A unique constraint covering the columns `[businessId,deviceId,checksum]` on the table `OfflineAction` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `checksum` to the `OfflineAction` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "OfflineDeviceStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OfflineActionStatus" ADD VALUE 'CONFLICT';
ALTER TYPE "OfflineActionStatus" ADD VALUE 'FAILED';

-- AlterTable
ALTER TABLE "OfflineAction" ADD COLUMN     "appliedAt" TIMESTAMP(3),
ADD COLUMN     "checksum" TEXT NOT NULL,
ADD COLUMN     "conflictPayload" JSONB,
ADD COLUMN     "conflictReason" TEXT,
ADD COLUMN     "errorMessage" TEXT,
ADD COLUMN     "localAuditId" TEXT,
ADD COLUMN     "provisionalAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OfflineDevice" ADD COLUMN     "permissionsSnapshot" JSONB,
ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "status" "OfflineDeviceStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateIndex
CREATE INDEX "OfflineAction_businessId_status_idx" ON "OfflineAction"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OfflineAction_businessId_deviceId_checksum_key" ON "OfflineAction"("businessId", "deviceId", "checksum");

-- CreateIndex
CREATE INDEX "OfflineDevice_businessId_status_idx" ON "OfflineDevice"("businessId", "status");
