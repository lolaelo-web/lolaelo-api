ALTER TABLE public."PropertyPhoto"
  DROP CONSTRAINT IF EXISTS "PropertyPhoto_roomTypeId_fkey";

ALTER TABLE public."PropertyPhoto"
  ADD CONSTRAINT "PropertyPhoto_roomTypeId_fkey"
  FOREIGN KEY ("roomTypeId")
  REFERENCES public."RoomType"("id")
  ON DELETE SET NULL
  ON UPDATE NO ACTION;