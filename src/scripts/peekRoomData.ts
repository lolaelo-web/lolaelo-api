// src/scripts/peekRoomData.ts
import { Pool } from "pg";

const [,, roomTypeIdArg, start, end] = process.argv;
if (!roomTypeIdArg || !start || !end) {
  console.error("Usage: npx tsx src/scripts/peekRoomData.ts <roomTypeId> <start:YYYY-MM-DD> <end:YYYY-MM-DD>");
  process.exit(1);
}
const roomTypeId = Number(roomTypeIdArg);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const inv = await pool.query(
    `SELECT id, "date", "roomsOpen", "minStay", "isClosed"
       FROM extranet."RoomInventory"
      WHERE "roomTypeId" = $1
        AND "date" >= $2::date
        AND "date" <  ($3::date + INTERVAL '1 day')
      ORDER BY "date" ASC`,
    [roomTypeId, start, end]
  );

  const zeroish = await pool.query(
    `SELECT id, "date", "roomsOpen", "minStay", "isClosed"
       FROM extranet."RoomInventory"
      WHERE "roomTypeId" = $1
        AND "date" >= $2::date
        AND "date" <  ($3::date + INTERVAL '1 day')
        AND "roomsOpen" = 0
        AND "isClosed" = FALSE
        AND ("minStay" IS NULL OR "minStay" = 0)
      ORDER BY "date" ASC`,
    [roomTypeId, start, end]
  );

  const prices = await pool.query(
    `SELECT id, "date", "ratePlanId", "price"
       FROM extranet."RoomPrice"
      WHERE "roomTypeId" = $1
        AND "date" >= $2::date
        AND "date" <  ($3::date + INTERVAL '1 day')
      ORDER BY "date" ASC`,
    [roomTypeId, start, end]
  );

  console.log("--- Inventory rows ---");
  console.table(inv.rows);
  console.log("--- Zero-only inventory rows (candidates to delete) ---");
  console.table(zeroish.rows);
  console.log("--- Price rows ---");
  console.table(prices.rows);

  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
