// src/db.ts
import { Pool } from "pg";

const cn = process.env.DATABASE_URL;
if (!cn) {
  console.warn("[db] DATABASE_URL is not set — routes may fall back to memory.");
}

// Render/Postgres needs SSL in most setups
export const pool = new Pool({
  connectionString: cn,
  ssl: cn?.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
});

// tiny helper so we can do: const { rows } = await q('select 1');
export const q = (text: string, params?: any[]) => pool.query(text, params);
