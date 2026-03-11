-- AddColumn approvalTier to Role
ALTER TABLE "Role" ADD COLUMN "approvalTier" INTEGER NOT NULL DEFAULT 0;

-- Set tiers for system roles by name
UPDATE "Role" SET "approvalTier" = 3 WHERE name = 'System Owner' AND "isSystem" = true;
UPDATE "Role" SET "approvalTier" = 2 WHERE name = 'Admin' AND "isSystem" = true;
UPDATE "Role" SET "approvalTier" = 1 WHERE name = 'Manager' AND "isSystem" = true;
-- Employee and Cashier stay at 0 (default)
