// src/scripts/fixRoomIndexes.ts
import { Client } from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set in your environment.");

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

  const stmts = [
    // 1) Ensure unique keys used by ON CONFLICT
    `CREATE UNIQUE INDEX IF NOT EXISTS "RoomInventory_roomTypeId_date_key"
       ON extranet."RoomInventory" ("roomTypeId","date");`,

    `CREATE UNIQUE INDEX IF NOT EXISTS "RoomPrice_roomTypeId_date_ratePlanId_key"
       ON extranet."RoomPrice" ("roomTypeId","date","ratePlanId");`,

    // 2) Normalize prior NULLs to an existing numeric plan per roomType (no text literals)
    //    If a roomType has at least one non-NULL plan id, reuse the smallest one.
    `WITH per_roomtype AS (
       SELECT "roomTypeId", MIN("ratePlanId") AS fill_id
       FROM extranet."RoomPrice"
       WHERE "ratePlanId" IS NOT NULL
       GROUP BY "roomTypeId"
     )
     UPDATE extranet."RoomPrice" rp
     SET "ratePlanId" = pr.fill_id
     FROM per_roomtype pr
     WHERE rp."ratePlanId" IS NULL
       AND rp."roomTypeId" = pr."roomTypeId";`,

    // 3) Show current indexes
    `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname='extranet'
         AND tablename IN ('RoomInventory','RoomPrice')
       ORDER BY indexname;`,
  ];

  await client.connect();
  for (let i = 0; i < stmts.length; i++) {
    const sql = stmts[i];
    console.log(`\n--- Running ${i + 1}/${stmts.length} ---\n${sql}\n`);
    const res = await client.query(sql);
    if (res.rows?.length) console.table(res.rows);
    if (res.rowCount !== undefined) console.log(`RowCount: ${res.rowCount}`);
  }
  await client.end();
  console.log("\n✅ Indexes ensured & NULL ratePlanId backfilled where possible.\n");
}

main().catch((e) => {
  console.error("❌ Fatal:", e);
  process.exit(1);
});
