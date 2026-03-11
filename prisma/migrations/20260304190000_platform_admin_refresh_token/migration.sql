-- Add PlatformAdminRefreshToken table for platform admin session management.
-- Mirrors the RefreshToken table but keyed on platformAdminId instead of userId.

CREATE TABLE "PlatformAdminRefreshToken" (
  "id"              TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
  "platformAdminId" TEXT         NOT NULL,
  "tokenHash"       TEXT         NOT NULL,
  "expiresAt"       TIMESTAMP(3) NOT NULL,
  "revokedAt"       TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PlatformAdminRefreshToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformAdminRefreshToken_platformAdminId_fkey"
    FOREIGN KEY ("platformAdminId")
    REFERENCES "PlatformAdmin"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "PlatformAdminRefreshToken_platformAdminId_idx"
  ON "PlatformAdminRefreshToken"("platformAdminId");
