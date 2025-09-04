// src/scripts/probeInventory.ts
import { Client } from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const roomTypeId = Number(process.argv[2] || 1);
  const dates = ["2025-09-10", "2025-09-11", "2025-09-12"];

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log(`\n--- Probe Inventory Upsert for roomTypeId=${roomTypeId} ---`);

  // Resolve partnerId from RoomType (authoritative)
  const roomRow = await client.query(
    `SELECT "partnerId","name" FROM extranet."RoomType" WHERE "id" = $1`,
    [roomTypeId]
  );
  console.table(roomRow.rows);
  const partnerId: number | null = roomRow.rows?.[0]?.partnerId ?? null;
  if (!partnerId) {
    console.error("❌ No partnerId on RoomType; aborting.");
    process.exit(2);
  }

  // Show RoomInventory columns (nullability/defaults)
  const cols = await client.query(`
    SELECT column_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema='extranet' AND table_name='RoomInventory'
    ORDER BY ordinal_position;
  `);
  console.table(cols.rows);

  // Try upserts exactly like the route
  await client.query("BEGIN");
  try {
    let upserted = 0;
    for (const d of dates) {
      const roomsOpen = d.endsWith("10") ? 5 : d.endsWith("11") ? 3 : 0;
      const minStay = d.endsWith("11") ? 2 : 1;
      const isClosed = d.endsWith("12");

      console.log(`\nUpsert: date=${d}, roomsOpen=${roomsOpen}, minStay=${minStay}, isClosed=${isClosed}`);
      try {
        await client.query(
          `INSERT INTO extranet."RoomInventory"
            ("partnerId","roomTypeId","date","roomsOpen","minStay","isClosed","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6, NOW(), NOW())
           ON CONFLICT ("roomTypeId","date")
           DO UPDATE SET "roomsOpen" = EXCLUDED."roomsOpen",
                         "minStay"   = EXCLUDED."minStay",
                         "isClosed"  = EXCLUDED."isClosed",
                         "updatedAt" = NOW()`,
          [partnerId, roomTypeId, d, roomsOpen, minStay, isClosed]
        );
        upserted++;
      } catch (e: any) {
        console.error("❌ Upsert error:", {
          message: e?.message,
          code: e?.code,
          detail: e?.detail,
          schema: e?.schema,
          table: e?.table,
          column: e?.column,
          constraint: e?.constraint,
        });
        throw e;
      }
    }
    await client.query("COMMIT");
    console.log(`\n✅ Probe upsert finished, upserted=${upserted}`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("❌ Transaction rolled back due to error.");
  }

  // Read back rows
  const rows = await client.query(
    `SELECT "id","partnerId","roomTypeId","date","roomsOpen","minStay","isClosed","createdAt","updatedAt"
       FROM extranet."RoomInventory"
      WHERE "roomTypeId" = $1 AND "date" BETWEEN $2 AND $3
      ORDER BY "date" ASC`,
    [roomTypeId, dates[0], dates[dates.length - 1]]
  );
  console.log("\n--- Current RoomInventory rows ---");
  console.table(rows.rows);

  await client.end();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
