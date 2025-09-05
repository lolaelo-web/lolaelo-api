// src/scripts/hardenRoomInventoryTimestamps.ts
import { Client } from "pg";
async function run(client, sql) {
    console.log("\n--- SQL ---\n" + sql.trim() + "\n");
    const res = await client.query(sql);
    return res;
}
async function main() {
    const url = process.env.DATABASE_URL;
    if (!url)
        throw new Error("DATABASE_URL is not set.");
    const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await client.connect();
    console.log("\n--- Harden timestamps on extranet.\"RoomInventory\" ---\n");
    // 1) Set DEFAULTs
    await run(client, `
    ALTER TABLE extranet."RoomInventory" ALTER COLUMN "createdAt" SET DEFAULT NOW();
    ALTER TABLE extranet."RoomInventory" ALTER COLUMN "updatedAt" SET DEFAULT NOW();
  `);
    // 2) Backfill NULLs (if any)
    const u1 = await run(client, `
    UPDATE extranet."RoomInventory"
       SET "createdAt" = NOW()
     WHERE "createdAt" IS NULL;
  `);
    const u2 = await run(client, `
    UPDATE extranet."RoomInventory"
       SET "updatedAt" = NOW()
     WHERE "updatedAt" IS NULL;
  `);
    // Plain string concatenation (avoid template literal pitfalls)
    console.log("Backfilled createdAt: " + (u1.rowCount ?? 0) + ", updatedAt: " + (u2.rowCount ?? 0));
    // 3) Show resulting columns/defaults
    const cols = await run(client, `
    SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema='extranet' AND table_name='RoomInventory'
     ORDER BY ordinal_position;
  `);
    if (cols.rows?.length) {
        console.table(cols.rows);
    }
    await client.end();
    console.log("\n✅ RoomInventory timestamps hardened (defaults + backfill).\n");
}
main().catch((e) => {
    console.error("❌ Fatal:", e);
    process.exit(1);
});
