ALTER TABLE extranet."PropertyPhoto"
  DROP CONSTRAINT IF EXISTS "extranet_PropertyPhoto_roomTypeId_fkey";

ALTER TABLE extranet."PropertyPhoto"
  ADD CONSTRAINT "extranet_PropertyPhoto_roomTypeId_fkey"
  FOREIGN KEY ("roomTypeId")
  REFERENCES extranet."RoomType"("id")
  ON DELETE SET NULL
  ON UPDATE NO ACTION;