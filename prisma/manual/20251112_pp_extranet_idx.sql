CREATE INDEX IF NOT EXISTS "extranet_PropertyPhoto_partner_room_idx"
  ON extranet."PropertyPhoto" ("partnerId","roomTypeId","sortOrder");