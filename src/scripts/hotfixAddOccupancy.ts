// src/scripts/hotfixAddOccupancy.ts
import { Client } from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const sql = `
    ALTER TABLE extranet."RoomType"
    ADD COLUMN IF NOT EXISTS "occupancy" integer NULL;
  `;
  console.log("\n--- Adding nullable occupancy to extranet.\"RoomType\" ---\n" + sql + "\n");
  await client.query(sql);

  // Show final table definition for confirmation
  const cols = await client.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema='extranet' AND table_name='RoomType'
    ORDER BY ordinal_position;
  `);
  console.table(cols.rows);

  await client.end();
  console.log("\n✅ Hotfix applied. RoomType.occupancy now exists (NULLable).");
}

main().catch((e) => {
  console.error("❌ Fatal:", e);
  process.exit(1);
});
