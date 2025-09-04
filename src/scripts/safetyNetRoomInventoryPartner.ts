// src/scripts/safetyNetRoomInventoryPartner.ts
import { Client } from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log("\n--- Safety net: RoomInventory.partnerId trigger ---\n");

  // 1) Create or replace function to fill partnerId from RoomType
  await client.query(`
    CREATE OR REPLACE FUNCTION extranet.fill_roominventory_partner()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW."partnerId" IS NULL THEN
        SELECT rt."partnerId"
          INTO NEW."partnerId"
          FROM extranet."RoomType" rt
         WHERE rt."id" = NEW."roomTypeId";
      END IF;
      RETURN NEW;
    END;
    $$;
  `);

  // 2) Create trigger (before insert/update)
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'trg_fill_roominventory_partner'
      ) THEN
        CREATE TRIGGER trg_fill_roominventory_partner
        BEFORE INSERT OR UPDATE ON extranet."RoomInventory"
        FOR EACH ROW
        EXECUTE FUNCTION extranet.fill_roominventory_partner();
      END IF;
    END $$;
  `);

  // 3) Backfill any existing rows with NULL partnerId (should be none due to NOT NULL, but safe)
  const upd = await client.query(`
    UPDATE extranet."RoomInventory" ri
       SET "partnerId" = rt."partnerId"
      FROM extranet."RoomType" rt
     WHERE ri."roomTypeId" = rt."id"
       AND ri."partnerId" IS NULL
  `);
  console.log("Backfilled rows:", upd.rowCount);

  // 4) Show a quick verification of function and trigger existence
  const fun = await client.query(`
    SELECT n.nspname AS schema, p.proname AS function
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='extranet' AND p.proname='fill_roominventory_partner';
  `);
  console.table(fun.rows);

  const trg = await client.query(`
    SELECT t.tgname AS trigger_name, c.relname AS table_name
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='extranet' AND c.relname='RoomInventory';
  `);
  console.table(trg.rows);

  await client.end();
  console.log("\n✅ Safety net in place for RoomInventory.partnerId.\n");
}

main().catch((e) => {
  console.error("❌ Fatal:", e);
  process.exit(1);
});
