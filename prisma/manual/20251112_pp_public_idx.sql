CREATE INDEX IF NOT EXISTS "PropertyPhoto_partner_room_idx"
  ON public."PropertyPhoto" ("partnerId","roomTypeId","sortOrder");