-- Add device binding for refresh tokens
ALTER TABLE "RefreshToken" ADD COLUMN "deviceId" TEXT;
