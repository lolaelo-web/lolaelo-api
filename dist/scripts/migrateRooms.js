// src/scripts/migrateRooms.ts
import { Client } from "pg";
const SQL = `
CREATE TABLE IF NOT EXISTS room_types (
  id           BIGSERIAL PRIMARY KEY,
  partner_id   BIGINT NOT NULL,
  name         TEXT NOT NULL,
  occupancy    INT  NOT NULL DEFAULT 2,
  code         TEXT,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_room_types_partner ON room_types(partner_id);

CREATE TABLE IF NOT EXISTS room_inventory (
  room_type_id BIGINT NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
  date         DATE   NOT NULL,
  rooms_open   INT,
  min_stay     INT,
  is_closed    BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (room_type_id, date)
);

CREATE TABLE IF NOT EXISTS room_prices (
  room_type_id BIGINT NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
  date         DATE   NOT NULL,
  rate_plan_id TEXT   NOT NULL DEFAULT 'base',
  price        NUMERIC(10,2) NOT NULL,
  PRIMARY KEY (room_type_id, date, rate_plan_id)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'touch_updated_at') THEN
    CREATE OR REPLACE FUNCTION touch_updated_at()
    RETURNS TRIGGER AS $f$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $f$ LANGUAGE plpgsql;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'room_types_touch_updated') THEN
    CREATE TRIGGER room_types_touch_updated
    BEFORE UPDATE ON room_types
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
END$$;
`;
async function main() {
    const url = process.env.DATABASE_URL;
    if (!url) {
        console.error("Missing DATABASE_URL env var. Grab it from Render → PostgreSQL → Connect.");
        process.exit(1);
    }
    const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("BEGIN");
    try {
        await client.query(SQL);
        await client.query("COMMIT");
        console.log("✅ Rooms schema migrated.");
    }
    catch (err) {
        await client.query("ROLLBACK");
        console.error("❌ Migration failed:", err.message);
        process.exit(1);
    }
    finally {
        await client.end();
    }
}
main().catch((e) => {
    console.error("❌ Fatal:", e);
    process.exit(1);
});
