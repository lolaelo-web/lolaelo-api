-- Fix FK for PropertyDocument.partnerId -> Partner(id)

-- Drop any existing FK on partnerId (name may vary across environments)
ALTER TABLE "PropertyDocument"
DROP CONSTRAINT IF EXISTS "PropertyDocument_partnerId_fkey";

-- Recreate FK pointing to Partner(id)
ALTER TABLE "PropertyDocument"
ADD CONSTRAINT "PropertyDocument_partnerId_fkey"
FOREIGN KEY ("partnerId") REFERENCES "Partner"("id")
ON DELETE CASCADE ON UPDATE CASCADE;