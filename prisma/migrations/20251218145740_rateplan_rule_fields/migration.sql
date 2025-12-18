-- Add rule fields to extranet.RatePlan
ALTER TABLE extranet."RatePlan"
  ADD COLUMN IF NOT EXISTS "code" TEXT,
  ADD COLUMN IF NOT EXISTS "kind" TEXT,
  ADD COLUMN IF NOT EXISTS "value" DECIMAL(10,4);

-- Optional index to speed lookups
CREATE INDEX IF NOT EXISTS "RatePlan_partner_room_code_idx"
  ON extranet."RatePlan" ("partnerId", "roomTypeId", "code");

-- Optional uniqueness guard (comment out if you have existing duplicates)
-- CREATE UNIQUE INDEX IF NOT EXISTS "RatePlan_room_code_uniq"
--   ON extranet."RatePlan" ("roomTypeId", "code");
