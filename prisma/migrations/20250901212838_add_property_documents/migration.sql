-- Enums
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DocumentType') THEN
    CREATE TYPE "DocumentType" AS ENUM (
      'GOVT_ID','BUSINESS_REG','TAX_ID','BANK_PROOF',
      'PROOF_OF_ADDRESS','INSURANCE_LIABILITY','PROPERTY_OWNERSHIP','LOCAL_LICENSE'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DocumentStatus') THEN
    CREATE TYPE "DocumentStatus" AS ENUM ('REQUIRED','SUBMITTED','APPROVED','REJECTED');
  END IF;
END$$;

-- Table
CREATE TABLE IF NOT EXISTS "PropertyDocument" (
  "id"          SERIAL PRIMARY KEY,
  "partnerId"   INTEGER      NOT NULL,
  "type"        "DocumentType" NOT NULL,
  "key"         TEXT         NOT NULL,
  "url"         TEXT         NOT NULL,
  "fileName"    TEXT,
  "contentType" TEXT,
  "status"      "DocumentStatus" NOT NULL DEFAULT 'SUBMITTED',
  "uploadedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verifiedAt"  TIMESTAMP(3),
  "expiresAt"   TIMESTAMP(3),
  "notes"       TEXT
);

-- Constraints & indexes
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name='PropertyDocument' AND constraint_name='PropertyDocument_partnerId_fkey'
  ) THEN
    ALTER TABLE "PropertyDocument"
      ADD CONSTRAINT "PropertyDocument_partnerId_fkey"
      FOREIGN KEY ("partnerId") REFERENCES "Partner"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

CREATE UNIQUE INDEX IF NOT EXISTS "PropertyDocument_key_key" ON "PropertyDocument"("key");
CREATE UNIQUE INDEX IF NOT EXISTS "PropertyDocument_partnerId_type_key" ON "PropertyDocument"("partnerId","type");
CREATE INDEX        IF NOT EXISTS "PropertyDocument_partnerId_idx" ON "PropertyDocument"("partnerId");