// ANCHOR: DB_POOL_FILE
import { Pool } from "pg";

const cs = process.env.DATABASE_URL || "";
const wantsSSL = /\bsslmode=require\b/i.test(cs) || /render\.com/i.test(cs);

export const pool = new Pool({
  connectionString: cs,
  ssl: wantsSSL ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
});
