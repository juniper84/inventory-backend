-- CreateEnum
CREATE TYPE "PlatformIncidentStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'MITIGATED', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PlatformIncidentSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateTable
CREATE TABLE "PlatformIncident" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "status" "PlatformIncidentStatus" NOT NULL DEFAULT 'OPEN',
    "severity" "PlatformIncidentSeverity" NOT NULL DEFAULT 'MEDIUM',
    "title" TEXT,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'LEGACY_REVIEW',
    "createdByPlatformAdminId" TEXT,
    "ownerPlatformAdminId" TEXT,
    "metadata" JSONB,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformIncidentEvent" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "fromStatus" "PlatformIncidentStatus",
    "toStatus" "PlatformIncidentStatus",
    "note" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByAdminId" TEXT,

    CONSTRAINT "PlatformIncidentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformIncident_businessId_status_createdAt_idx" ON "PlatformIncident"("businessId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "PlatformIncident_status_severity_createdAt_idx" ON "PlatformIncident"("status", "severity", "createdAt");

-- CreateIndex
CREATE INDEX "PlatformIncidentEvent_incidentId_createdAt_idx" ON "PlatformIncidentEvent"("incidentId", "createdAt");

-- CreateIndex
CREATE INDEX "PlatformIncidentEvent_createdByAdminId_createdAt_idx" ON "PlatformIncidentEvent"("createdByAdminId", "createdAt");

-- AddForeignKey
ALTER TABLE "PlatformIncident" ADD CONSTRAINT "PlatformIncident_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformIncident" ADD CONSTRAINT "PlatformIncident_createdByPlatformAdminId_fkey" FOREIGN KEY ("createdByPlatformAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformIncident" ADD CONSTRAINT "PlatformIncident_ownerPlatformAdminId_fkey" FOREIGN KEY ("ownerPlatformAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformIncidentEvent" ADD CONSTRAINT "PlatformIncidentEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "PlatformIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformIncidentEvent" ADD CONSTRAINT "PlatformIncidentEvent_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE SET NULL ON UPDATE CASCADE;
