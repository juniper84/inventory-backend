-- Track onboarding progress for required setup steps
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "onboarding" JSONB;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "onboardingCompletedAt" TIMESTAMP(3);
