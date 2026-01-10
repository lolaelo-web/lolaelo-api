-- Add rule fields to extranet.RatePlan (shadow-safe)
CREATE SCHEMA IF NOT EXISTS extranet;

-- Ensure base columns exist (needed for index)
ALTER TABLE extranet."RatePlan"
  ADD COLUMN IF NOT EXISTS "partnerId" INTEGER,
  ADD COLUMN IF NOT EXISTS "roomTypeId" INTEGER;

-- Add rule fields
ALTER TABLE extranet."RatePlan"
  ADD COLUMN IF NOT EXISTS "code" TEXT,
  ADD COLUMN IF NOT EXISTS "kind" TEXT,
  ADD COLUMN IF NOT EXISTS "value" DECIMAL(10,4);

-- Optional index to speed lookups
CREATE INDEX IF NOT EXISTS "RatePlan_partner_room_code_idx"
  ON extranet."RatePlan" ("partnerId", "roomTypeId", "code");
