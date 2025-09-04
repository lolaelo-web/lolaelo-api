import { Router } from "express";
import { Pool } from "pg";

const r = Router();

// ---- PG pool (Render) ----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Render Postgres uses SSL
});

// ---- Helpers ----
function parseDate(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

// Table names
const T = {
  rooms: `extranet."RoomType"`,
  inv: `extranet."RoomInventory"`,
  prices: `extranet."RoomPrice"`,
};

/** GET /extranet/property/rooms */
r.get("/", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT "id","name","code","description"
         FROM ${T.rooms}
        ORDER BY "id" ASC`
    );
    return res.status(200).json(rows);
  } catch (e) {
    console.error("[rooms:get] db error", e);
    return res.status(500).json({ error: "Rooms list failed" });
  }
});

/** POST /extranet/property/rooms */
r.post("/", async (req, res) => {
  try {
    const { name, code, description } = req.body ?? {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }

    const { rows } = await pool.query(
      `INSERT INTO ${T.rooms} ("name","code","description")
            VALUES ($1,$2,$3)
        RETURNING "id","name","code","description"`,
      [name.trim(), code ?? null, description ?? null]
    );

    return res.status(201).json(rows[0]);
  } catch (e) {
    console.error("[rooms:post] db error", e);
    return res.status(500).json({ error: "Create failed" });
  }
});

/** GET /:id/inventory */
r.get("/:id/inventory", async (req, res) => {
  try {
    const roomId = Number(req.params.id);
    const start = String(req.query.start || "");
    const end = String(req.query.end || "");
    const ds = parseDate(start);
    const de = parseDate(end);
    if (!roomId || !ds || !de) return res.status(400).json({ error: "bad params" });

    const { rows } = await pool.query(
      `SELECT "date","roomsOpen","minStay","isClosed"
         FROM ${T.inv}
        WHERE "roomTypeId" = $1
          AND "date" BETWEEN $2 AND $3
        ORDER BY "date" ASC`,
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

    // Resolve partnerId from the room type (authoritative)
    const roomRow = await client.query(
      `SELECT "partnerId" FROM ${T.rooms} WHERE "id" = $1`,
      [roomId]
    );
    const partnerId: number | null = roomRow.rows?.[0]?.partnerId ?? null;
    if (!partnerId) return res.status(400).json({ error: "invalid roomTypeId (no partner)" });

    await client.query("BEGIN");

    let upserted = 0;
    for (const it of items) {
      if (!it?.date || !parseDate(it.date)) continue;
      // force safe values (roomsOpen/isClosed are NOT NULL in DB)
      const roomsOpen = Number.isFinite(Number(it.roomsOpen)) ? Number(it.roomsOpen) : 0;
      const minStay = it.minStay == null ? null : Number(it.minStay);
      const isClosed = Boolean(it.isClosed);

      await client.query(
        `INSERT INTO ${T.inv} ("partnerId","roomTypeId","date","roomsOpen","minStay","isClosed","createdAt","updatedAt")
              VALUES ($1,$2,$3,$4,$5,$6, NOW(), NOW())
        ON CONFLICT ("roomTypeId","date")
          DO UPDATE SET "roomsOpen" = EXCLUDED."roomsOpen",
                        "minStay"   = EXCLUDED."minStay",
                        "isClosed"  = EXCLUDED."isClosed",
                        "updatedAt" = NOW()`,
        [partnerId, roomId, it.date, roomsOpen, minStay, isClosed]
      );
      upserted++;
    }

    await client.query("COMMIT");
    return res.json({ ok: true, upserted });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[inventory:bulk] db error", e);
    return res.status(500).json({ error: "Inventory save failed" });
  } finally {
    client.release();
  }
});

/** GET /:id/prices */
r.get("/:id/prices", async (req, res) => {
  try {
    const roomId = Number(req.params.id);
    const start = String(req.query.start || "");
    const end = String(req.query.end || "");
    const ds = parseDate(start);
    const de = parseDate(end);
    if (!roomId || !ds || !de) return res.status(400).json({ error: "bad params" });

    const { rows } = await pool.query(
      `SELECT "date","ratePlanId","price"
         FROM ${T.prices}
        WHERE "roomTypeId" = $1
          AND "date" BETWEEN $2 AND $3
        ORDER BY "date" ASC`,
      [roomId, start, end]
    );
    return res.json(rows);
  } catch (e) {
    console.error("[prices:get] db error", e);
    return res.status(500).json({ error: "Prices fetch failed" });
  }
});

/** POST /:id/inventory/bulk  { items:[{date,roomsOpen,minStay,isClosed}] } */
r.post("/:id/inventory/bulk", async (req, res) => {
  const client = await pool.connect();
  try {
    const roomId = Number(req.params.id);
    const { items } = req.body ?? {};
    if (!roomId || !Array.isArray(items)) return res.status(400).json({ error: "bad payload" });

    // Resolve partnerId from the room type (authoritative)
    const roomRow = await client.query(
      `SELECT "partnerId" FROM ${T.rooms} WHERE "id" = $1`,
      [roomId]
    );
    const partnerId: number | null = roomRow.rows?.[0]?.partnerId ?? null;
    if (!partnerId) return res.status(400).json({ error: "invalid roomTypeId (no partner)" });

    await client.query("BEGIN");

    let upserted = 0;
    for (const it of items) {
      if (!it?.date || !parseDate(it.date)) continue;

      // Force NOT NULL-safe values for NOT NULL columns
      const roomsOpen = Number.isFinite(Number(it.roomsOpen)) ? Number(it.roomsOpen) : 0;
      const minStay = it.minStay == null ? null : Number(it.minStay);
      const isClosed = Boolean(it.isClosed);

      await client.query(
        `INSERT INTO ${T.inv} ("partnerId","roomTypeId","date","roomsOpen","minStay","isClosed","createdAt","updatedAt")
              VALUES ($1,$2,$3,$4,$5,$6, NOW(), NOW())
         ON CONFLICT ("roomTypeId","date")
           DO UPDATE SET "roomsOpen" = EXCLUDED."roomsOpen",
                         "minStay"   = EXCLUDED."minStay",
                         "isClosed"  = EXCLUDED."isClosed",
                         "updatedAt" = NOW()`,
        [partnerId, roomId, it.date, roomsOpen, minStay, isClosed]
      );
      upserted++;
    }

    await client.query("COMMIT");
    return res.json({ ok: true, upserted });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[inventory:bulk] db error", e);
    return res.status(500).json({ error: "Inventory save failed" });
  } finally {
    client.release();
  }
});

// Debug
const BOOT_ID = Math.random().toString(36).slice(2, 9);
r.get("/__debug", async (_req, res) => {
  try {
    const ping = await pool.query("select now()");
    res.json({ ok: true, bootId: BOOT_ID, dbNow: ping.rows?.[0]?.now ?? null });
  } catch (e) {
    res.json({ ok: false, bootId: BOOT_ID, dbError: String(e) });
  }
});

export default r;
