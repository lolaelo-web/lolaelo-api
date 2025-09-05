// src/scripts/cleanupZeroInventory.ts
import { Pool } from "pg";

const [,, roomTypeIdArg, start, end] = process.argv;
if (!roomTypeIdArg || !start || !end) {
  console.error("Usage: npx tsx src/scripts/cleanupZeroInventory.ts <roomTypeId> <start:YYYY-MM-DD> <end:YYYY-MM-DD>");
  process.exit(1);
}
const roomTypeId = Number(roomTypeIdArg);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const before = await pool.query(
    `SELECT COUNT(*)::int AS cnt
       FROM extranet."RoomInventory"
      WHERE "roomTypeId" = $1
        AND "date" >= $2::date
        AND "date" <  ($3::date + INTERVAL '1 day')
        AND "roomsOpen" = 0
        AND "isClosed" = FALSE
        AND ("minStay" IS NULL OR "minStay" = 0)`,
    [roomTypeId, start, end]
  );
  const del = await pool.query(
    `DELETE FROM extranet."RoomInventory"
      WHERE "roomTypeId" = $1
        AND "date" >= $2::date
        AND "date" <  ($3::date + INTERVAL '1 day')
        AND "roomsOpen" = 0
        AND "isClosed" = FALSE
        AND ("minStay" IS NULL OR "minStay" = 0)`,
    [roomTypeId, start, end]
  );
  console.log(`Deleted ${before.rows[0].cnt} zero-only rows. Affected=${del.rowCount}`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
