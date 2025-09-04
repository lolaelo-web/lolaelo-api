// src/scripts/dbHardening.ts
import { Client } from "pg";

async function run(sql: string, client: Client) {
  console.log("\n--- SQL ---\n" + sql.trim() + "\n");
  const res = await client.query(sql);
  if ((res as any).rows?.length) console.table((res as any).rows);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log("\n=== DB HARDENING START ===\n");

  // ---------- INDEXES ----------
  await run(`
    CREATE UNIQUE INDEX IF NOT EXISTS "RoomInventory_roomTypeId_date_key"
      ON extranet."RoomInventory" ("roomTypeId","date");

    CREATE UNIQUE INDEX IF NOT EXISTS "RoomPrice_roomTypeId_date_ratePlanId_key"
      ON extranet."RoomPrice" ("roomTypeId","date","ratePlanId");

    -- remove old redundant ordering variant if it exists
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname='extranet' AND indexname='RoomPrice_roomTypeId_ratePlanId_date_key'
      ) THEN
        EXECUTE 'DROP INDEX extranet."RoomPrice_roomTypeId_ratePlanId_date_key"';
      END IF;
    END $$;
  `, client);

  // ---------- TIMESTAMP DEFAULTS + BACKFILL ----------
  await run(`
    -- RoomPrice
    ALTER TABLE extranet."RoomPrice"  ALTER COLUMN "createdAt" SET DEFAULT NOW();
    ALTER TABLE extranet."RoomPrice"  ALTER COLUMN "updatedAt" SET DEFAULT NOW();
    UPDATE extranet."RoomPrice"  SET "createdAt" = NOW() WHERE "createdAt" IS NULL;
    UPDATE extranet."RoomPrice"  SET "updatedAt" = NOW() WHERE "updatedAt" IS NULL;

    -- RoomInventory
    ALTER TABLE extranet."RoomInventory" ALTER COLUMN "createdAt" SET DEFAULT NOW();
    ALTER TABLE extranet."RoomInventory" ALTER COLUMN "updatedAt" SET DEFAULT NOW();
    UPDATE extranet."RoomInventory" SET "createdAt" = NOW() WHERE "createdAt" IS NULL;
    UPDATE extranet."RoomInventory" SET "updatedAt" = NOW() WHERE "updatedAt" IS NULL;
  `, client);

  // ---------- RATEPLAN NORMALIZATION (if text-based earlier) ----------
  // Keep ONLY if your schema still allows NULL; our current schema has NOT NULL enforced.
  await run(`
    -- If "ratePlanId" can be NULL in your historical data, backfill to a valid ID.
    -- Here we choose the minimum plan per roomType; adjust if you prefer a specific ID.
    WITH per_roomtype AS (
      SELECT "roomTypeId", MIN("ratePlanId") AS fill_id
      FROM extranet."RoomPrice"
      WHERE "ratePlanId" IS NOT NULL
      GROUP BY "roomTypeId"
    )
    UPDATE extranet."RoomPrice" rp
       SET "ratePlanId" = pr.fill_id
      FROM per_roomtype pr
     WHERE rp."ratePlanId" IS NULL
       AND rp."roomTypeId" = pr."roomTypeId";
  `, client);

  await run(`
    -- Enforce NOT NULL on ratePlanId (safe after backfill)
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='extranet' AND table_name='RoomPrice'
          AND column_name='ratePlanId' AND is_nullable='YES'
      ) THEN
        EXECUTE 'ALTER TABLE extranet."RoomPrice" ALTER COLUMN "ratePlanId" SET NOT NULL';
      END IF;
    END $$;
  `, client);

  // ---------- CHECK CONSTRAINTS ----------
  await run(`
    -- roomsOpen >= 0
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='roominventory_roomsopen_nonneg'
      ) THEN
        ALTER TABLE extranet."RoomInventory"
          ADD CONSTRAINT roominventory_roomsopen_nonneg CHECK ("roomsOpen" >= 0);
      END IF;
    END $$;

    -- minStay NULL or >= 1
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='roominventory_minstay_valid'
      ) THEN
        ALTER TABLE extranet."RoomInventory"
          ADD CONSTRAINT roominventory_minstay_valid CHECK ("minStay" IS NULL OR "minStay" >= 1);
      END IF;
    END $$;

    -- price >= 0
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='roomprice_price_nonneg'
      ) THEN
        ALTER TABLE extranet."RoomPrice"
          ADD CONSTRAINT roomprice_price_nonneg CHECK ("price" >= 0);
      END IF;
    END $$;
  `, client);

  // ---------- SAFETY NET TRIGGERS: partnerId autofill ----------
  await run(`
    -- Function + trigger for RoomInventory.partnerId
    CREATE OR REPLACE FUNCTION extranet.fill_roominventory_partner()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW."partnerId" IS NULL THEN
        SELECT rt."partnerId" INTO NEW."partnerId"
        FROM extranet."RoomType" rt
        WHERE rt."id" = NEW."roomTypeId";
      END IF;
      RETURN NEW;
    END;
    $$;

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_fill_roominventory_partner') THEN
        CREATE TRIGGER trg_fill_roominventory_partner
        BEFORE INSERT OR UPDATE ON extranet."RoomInventory"
        FOR EACH ROW
        EXECUTE FUNCTION extranet.fill_roominventory_partner();
      END IF;
    END $$;

    -- Backfill any existing NULLs (should be none due to NOT NULL, but harmless)
    UPDATE extranet."RoomInventory" ri
       SET "partnerId" = rt."partnerId"
      FROM extranet."RoomType" rt
     WHERE ri."roomTypeId" = rt."id"
       AND ri."partnerId" IS NULL;
  `, client);

  await run(`
    -- Function + trigger for RoomPrice.partnerId
    CREATE OR REPLACE FUNCTION extranet.fill_roomprice_partner()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW."partnerId" IS NULL THEN
        SELECT rt."partnerId" INTO NEW."partnerId"
        FROM extranet."RoomType" rt
        WHERE rt."id" = NEW."roomTypeId";
      END IF;
      RETURN NEW;
    END;
    $$;

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_fill_roomprice_partner') THEN
        CREATE TRIGGER trg_fill_roomprice_partner
        BEFORE INSERT OR UPDATE ON extranet."RoomPrice"
        FOR EACH ROW
        EXECUTE FUNCTION extranet.fill_roomprice_partner();
      END IF;
    END $$;

    UPDATE extranet."RoomPrice" rp
       SET "partnerId" = rt."partnerId"
      FROM extranet."RoomType" rt
     WHERE rp."roomTypeId" = rt."id"
       AND rp."partnerId" IS NULL;
  `, client);

  // ---------- VISIBILITY: columns + indexes ----------
  await run(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema='extranet' AND table_name='RoomInventory'
    ORDER BY ordinal_position;
  `, client);

  await run(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema='extranet' AND table_name='RoomPrice'
    ORDER BY ordinal_position;
  `, client);

  await run(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname='extranet'
      AND tablename IN ('RoomInventory','RoomPrice')
    ORDER BY indexname;
  `, client);

  await client.end();
  console.log("\n=== DB HARDENING COMPLETE ===\n");
}

main().catch((e) => {
  console.error("❌ Fatal:", e);
  process.exit(1);
});
