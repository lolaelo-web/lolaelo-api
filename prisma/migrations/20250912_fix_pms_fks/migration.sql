-- Re-introduce FKs to extranet schema (guarded; safe to re-run)

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PmsMapping_localRoomTypeId_extranet_fkey'
  ) THEN
    ALTER TABLE "PmsMapping"
      ADD CONSTRAINT "PmsMapping_localRoomTypeId_extranet_fkey"
      FOREIGN KEY ("localRoomTypeId")
      REFERENCES "extranet"."RoomType"("id")
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PmsMapping_localRatePlanId_extranet_fkey'
  ) THEN
    ALTER TABLE "PmsMapping"
      ADD CONSTRAINT "PmsMapping_localRatePlanId_extranet_fkey"
      FOREIGN KEY ("localRatePlanId")
      REFERENCES "extranet"."RatePlan"("id")
      ON DELETE SET NULL;
  END IF;
END $$;