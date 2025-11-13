-- === PUBLIC schema ===
ALTER TABLE public."PropertyPhoto"
  ADD COLUMN IF NOT EXISTS "roomTypeId" INTEGER NULL;

CREATE INDEX IF NOT EXISTS "PropertyPhoto_partner_room_idx"
  ON public."PropertyPhoto" ("partnerId","roomTypeId","sortOrder");

ALTER TABLE public."PropertyPhoto"
  DROP CONSTRAINT IF EXISTS "PropertyPhoto_roomTypeId_fkey";

ALTER TABLE public."PropertyPhoto"
  ADD CONSTRAINT "PropertyPhoto_roomTypeId_fkey"
  FOREIGN KEY ("roomTypeId")
  REFERENCES public."RoomType"("id")
  ON DELETE SET NULL
  ON UPDATE NO ACTION;

-- === EXTRANET schema ===
ALTER TABLE extranet."PropertyPhoto"
  ADD COLUMN IF NOT EXISTS "roomTypeId" INTEGER NULL;

CREATE INDEX IF NOT EXISTS "extranet_PropertyPhoto_partner_room_idx"
  ON extranet."PropertyPhoto" ("partnerId","roomTypeId","sortOrder");

ALTER TABLE extranet."PropertyPhoto"
  DROP CONSTRAINT IF EXISTS "extranet_PropertyPhoto_roomTypeId_fkey";

ALTER TABLE extranet."PropertyPhoto"
  ADD CONSTRAINT "extranet_PropertyPhoto_roomTypeId_fkey"
  FOREIGN KEY ("roomTypeId")
  REFERENCES extranet."RoomType"("id"
  )
  ON DELETE SET NULL
  ON UPDATE NO ACTION;
