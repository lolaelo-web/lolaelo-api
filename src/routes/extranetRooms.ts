import { Router } from "express";
import { Pool } from "pg";

const r = Router();

// ---- PG pool (Render) ----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render Postgres uses SSL
  ssl: { rejectUnauthorized: false },
});

// ---- Helpers ----
function parseDate(s: string) {
  // yyyy-mm-dd
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

// For safety, always fully-qualify with schema "extranet"
const T = {
  rooms: "extranet.room_types",
  inv: "extranet.room_inventory",
  prices: "extranet.room_prices",
};

/** GET /extranet/property/rooms  -> list rooms */
r.get("/", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, occupancy, code, description
       FROM ${T.rooms}
       ORDER BY id ASC`
    );
    return res.status(200).json(rows);
  } catch (e) {
    console.error("[rooms:get] db error", e);
    return res.status(500).json({ error: "Rooms list failed" });
  }
});

/** POST /extranet/property/rooms -> create room */
r.post("/", async (req, res) => {
  try {
    const { name, occupancy, code, description } = req.body ?? {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }
    const occ = occupancy == null ? 2 : Number(occupancy);
    const { rows } = await pool.query(
      `INSERT INTO ${T.rooms} (name, occupancy, code, description)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, occupancy, code, description`,
      [name.trim(), occ, code ?? null, description ?? null]
    );
    return res.status(201).json(rows[0]);
  } catch (e) {
    console.error("[rooms:post] db error", e);
    return res.status(500).json({ error: "Create failed" });
  }
});

/** GET /:id/inventory?start=YYYY-MM-DD&end=YYYY-MM-DD */
r.get("/:id/inventory", async (req, res) => {
  try {
    const roomId = Number(req.params.id);
    const start = String(req.query.start || "");
    const end = String(req.query.end || "");
    const ds = parseDate(start);
    const de = parseDate(end);
    if (!roomId || !ds || !de) return res.status(400).json({ error: "bad params" });

    const { rows } = await pool.query(
      `SELECT date, rooms_open AS "roomsOpen", min_stay AS "minStay", is_closed AS "isClosed"
       FROM ${T.inv}
       WHERE room_id = $1 AND date BETWEEN $2 AND $3
       ORDER BY date ASC`,
      [roomId, start, end]
    );

    return res.json(rows);
  } catch (e) {
    console.error("[inventory:get] db error", e);
    return res.status(500).json({ error: "Inventory fetch failed" });
  }
});

/** POST /:id/inventory/bulk  { items:[{date,roomsOpen,minStay,isClosed}] } */
r.post("/:id/inventory/bulk", async (req, res) => {
  const client = await pool.connect();
  try {
    const roomId = Number(req.params.id);
    const { items } = req.body ?? {};
    if (!roomId || !Array.isArray(items)) return res.status(400).json({ error: "bad payload" });

    await client.query("BEGIN");

    let upserted = 0;
    for (const it of items) {
      if (!it?.date || !parseDate(it.date)) continue;
      const roomsOpen = it.roomsOpen == null ? null : Number(it.roomsOpen);
      const minStay = it.minStay == null ? null : Number(it.minStay);
      const isClosed = !!it.isClosed;

      await client.query(
        `INSERT INTO ${T.inv} (room_id, date, rooms_open, min_stay, is_closed)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (room_id, date)
         DO UPDATE SET rooms_open = EXCLUDED.rooms_open,
                       min_stay  = EXCLUDED.min_stay,
                       is_closed = EXCLUDED.is_closed`,
        [roomId, it.date, roomsOpen, minStay, isClosed]
      );
      upserted++;
    }

    await client.query("COMMIT");
    return res.json({ ok: true, upserted });
  } catch (e) {
    await pool.query("ROLLBACK");
    console.error("[inventory:bulk] db error", e);
    return res.status(500).json({ error: "Inventory save failed" });
  } finally {
    client.release();
  }
});

/** GET /:id/prices?start=YYYY-MM-DD&end=YYYY-MM-DD */
r.get("/:id/prices", async (req, res) => {
  try {
    const roomId = Number(req.params.id);
    const start = String(req.query.start || "");
    const end = String(req.query.end || "");
    const ds = parseDate(start);
    const de = parseDate(end);
    if (!roomId || !ds || !de) return res.status(400).json({ error: "bad params" });

    const { rows } = await pool.query(
      `SELECT date, rate_plan_id AS "ratePlanId", price
       FROM ${T.prices}
       WHERE room_id = $1 AND date BETWEEN $2 AND $3
       ORDER BY date ASC`,
      [roomId, start, end]
    );

    return res.json(rows);
  } catch (e) {
    console.error("[prices:get] db error", e);
    return res.status(500).json({ error: "Prices fetch failed" });
  }
});

/** POST /:id/prices/bulk  { items:[{date,price,ratePlanId}] } */
r.post("/:id/prices/bulk", async (req, res) => {
  const client = await pool.connect();
  try {
    const roomId = Number(req.params.id);
    const { items } = req.body ?? {};
    if (!roomId || !Array.isArray(items)) return res.status(400).json({ error: "bad payload" });

    await client.query("BEGIN");

    let upserted = 0;
    for (const it of items) {
      if (!it?.date || !parseDate(it.date)) continue;
      const ratePlanId = it.ratePlanId ?? null;
      const price = Number(it.price ?? 0);

      await client.query(
        `INSERT INTO ${T.prices} (room_id, date, rate_plan_id, price)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (room_id, date, COALESCE(rate_plan_id, 'base'))
         DO UPDATE SET price = EXCLUDED.price,
                       rate_plan_id = EXCLUDED.rate_plan_id`,
        [roomId, it.date, ratePlanId, price]
      );
      upserted++;
    }

    await client.query("COMMIT");
    return res.json({ ok: true, upserted });
  } catch (e) {
    await pool.query("ROLLBACK");
    console.error("[prices:bulk] db error", e);
    return res.status(500).json({ error: "Prices save failed" });
  } finally {
    client.release();
  }
});

// Debug route (kept)
const BOOT_ID = Math.random().toString(36).slice(2, 9);
r.get("/__debug", async (_req, res) => {
  try {
    const ping = await pool.query("select now()");
    res.json({
      ok: true,
      bootId: BOOT_ID,
      dbNow: ping.rows?.[0]?.now ?? null,
    });
  } catch (e) {
    res.json({ ok: false, bootId: BOOT_ID, dbError: String(e) });
  }
});

export default r;
