// src/scripts/hardenRoomPriceTimestamps.ts
import { Client } from "pg";
async function main() {
    const url = process.env.DATABASE_URL;
    if (!url)
        throw new Error("DATABASE_URL is not set.");
    const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await client.connect();
    console.log("\n--- Harden timestamps on extranet.\"RoomPrice\" ---\n");
    // 1) Add sane defaults
    await client.query(`ALTER TABLE extranet."RoomPrice" ALTER COLUMN "createdAt" SET DEFAULT NOW();`);
    await client.query(`ALTER TABLE extranet."RoomPrice" ALTER COLUMN "updatedAt" SET DEFAULT NOW();`);
    // 2) Backfill any NULLs
    const upd1 = await client.query(`UPDATE extranet."RoomPrice" SET "createdAt" = NOW() WHERE "createdAt" IS NULL;`);
    const upd2 = await client.query(`UPDATE extranet."RoomPrice" SET "updatedAt" = NOW() WHERE "updatedAt" IS NULL;`);
    console.log(`Backfilled createdAt: ${upd1.rowCount}, updatedAt: ${upd2.rowCount}`);
    // 3) Show table column defaults & nullability for verification
    const cols = await client.query(`
    SELECT column_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema='extranet' AND table_name='RoomPrice'
    ORDER BY ordinal_position;
  `);
    console.table(cols.rows);
    await client.end();
    console.log("\n✅ RoomPrice timestamps hardened (defaults + backfill).\n");
}
main().catch((e) => {
    console.error("❌ Fatal:", e);
    process.exit(1);
});
