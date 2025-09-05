import { Pool } from "pg";

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const sql = `
  CREATE SCHEMA IF NOT EXISTS extranet;

  CREATE TABLE IF NOT EXISTS extranet."PropertyProfile" (
    "partnerId"    integer PRIMARY KEY,
    "name"         text NOT NULL,
    "contactEmail" text,
    "phone"        text,
    "country"      text,
    "addressLine"  text,
    "city"         text,
    "description"  text,
    "createdAt"    timestamp NOT NULL DEFAULT NOW(),
    "updatedAt"    timestamp NOT NULL DEFAULT NOW()
  );
  `;
  await pool.query(sql);
  console.log("PropertyProfile ensured.");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
