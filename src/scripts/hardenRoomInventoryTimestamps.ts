// src/scripts/hardenRoomInventoryTimestamps.ts
import { Client } from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log("\n--- Harden timestamps on extranet.\"RoomInventory\" ---\n");

  // Add sane defaults for createdAt / updatedAt (safe if they already exist)
  await client.query(`ALTER TABLE extranet."RoomInventory" ALTER COLUMN "createdAt" SET DEFAULT NOW();`);
  await client.query(`ALTER TABLE extranet."RoomInventory" ALTER COLUMN "updatedAt" SET DEFAULT NOW();`);

  // Backfill any NULLs just in case
  const u1 = await client.query(`UPDATE extranet."RoomInventory" SET "createdAt" = NOW() WHERE "createdAt" IS NULL;`);
  const u2 = await client.query(`UPDATE extranet."RoomInventory" SET "updatedAt" = NOW() WHERE "updatedAt" IS NULL;`);
  console.log(\`Backfilled createdAt: \${u1.rowCount}, updatedAt: \${u2.rowCount}\`);

  const cols = await client.query(`
    SELECT column_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema='extranet' AND table_name='RoomInventory'
    ORDER BY ordinal_position;
  `);
  console.table(cols.rows);

  await client.end();
  console.log("\n✅ RoomInventory timestamps hardened (defaults + backfill).\n");
}

main().catch((e) => {
  console.error("❌ Fatal:", e);
  process.exit(1);
});
