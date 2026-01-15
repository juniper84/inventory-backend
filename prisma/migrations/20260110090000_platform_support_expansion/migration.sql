-- Platform support access scope + incident severity
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "reviewSeverity" TEXT;
ALTER TABLE "SupportAccessRequest" ADD COLUMN IF NOT EXISTS "scope" JSONB;
ALTER TABLE "SupportAccessRequest" ADD COLUMN IF NOT EXISTS "durationHours" INTEGER;
ALTER TABLE "SupportAccessSession" ADD COLUMN IF NOT EXISTS "scope" JSONB;
