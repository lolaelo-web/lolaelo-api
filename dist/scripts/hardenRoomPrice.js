// src/scripts/hardenRoomPrice.ts
import { Client } from "pg";
async function main() {
    const url = process.env.DATABASE_URL;
    if (!url)
        throw new Error("DATABASE_URL is not set.");
    const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await client.connect();
    // 1) Drop redundant index (safe to run repeatedly)
    const dropIdx = `DROP INDEX IF EXISTS extranet."RoomPrice_roomTypeId_ratePlanId_date_key";`;
    console.log("\n--- Drop redundant index ---\n" + dropIdx + "\n");
    await client.query(dropIdx);
    // 2) Show remaining indexes
    const showIdx = `
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname='extranet'
      AND tablename IN ('RoomPrice','RoomInventory')
    ORDER BY indexname;`;
    const idxRes = await client.query(showIdx);
    if (idxRes.rows?.length)
        console.table(idxRes.rows);
    // 3) Count any NULL ratePlanId and enforce NOT NULL if safe
    const nullCountSql = `SELECT COUNT(*)::int AS null_count FROM extranet."RoomPrice" WHERE "ratePlanId" IS NULL;`;
    const nullCount = (await client.query(nullCountSql)).rows[0]?.null_count ?? 0;
    console.log(`\nNULL ratePlanId rows: ${nullCount}`);
    if (nullCount === 0) {
        const setNotNull = `ALTER TABLE extranet."RoomPrice" ALTER COLUMN "ratePlanId" SET NOT NULL;`;
        console.log("\n--- Enforcing NOT NULL on RoomPrice.ratePlanId ---\n" + setNotNull + "\n");
        await client.query(setNotNull);
    }
    else {
        console.log("\nSkipped NOT NULL enforcement because NULLs exist.");
    }
    // 4) Inspect RatePlan schema (don't assume column names)
    const colsSql = `
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema='extranet' AND table_name='RatePlan'
    ORDER BY ordinal_position;`;
    console.log("\n--- RatePlan columns ---\n" + colsSql + "\n");
    const cols = await client.query(colsSql);
    if (cols.rows?.length)
        console.table(cols.rows);
    else
        console.log("No columns found for extranet.\"RatePlan\" (unexpected).");
    // 5) List first 50 RatePlan rows using wildcard (so whatever columns exist are shown)
    const plansSql = `SELECT * FROM extranet."RatePlan" ORDER BY 1 LIMIT 50;`;
    console.log("\n--- RatePlan rows (first 50) ---\n" + plansSql + "\n");
    const plans = await client.query(plansSql);
    if (plans.rows?.length)
        console.table(plans.rows);
    else
        console.log("No rate plans found.");
    await client.end();
    console.log("\n✅ RoomPrice hardened; RatePlan schema/rows printed.");
}
main().catch((e) => {
    console.error("❌ Fatal:", e);
    process.exit(1);
});
