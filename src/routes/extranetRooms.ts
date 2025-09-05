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
    res.set("Cache-Control", "no-store");
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
  const client = await pool.connect();
  try {
    const { name, code, description, occupancy } = req.body ?? {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }

    await client.query("BEGIN");

    // derive partnerId: prefer auth, else reuse first existing room's partnerId
    let partnerId: number | null =
      (req as any).partner?.id ??
      (req as any).partnerId ??
      null;

    if (!partnerId) {
      const probe = await client.query(
        `SELECT "partnerId" FROM ${T.rooms} ORDER BY "id" ASC LIMIT 1`
      );
      partnerId = probe.rows?.[0]?.partnerId ?? null;
    }

    if (!partnerId) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "unable to determine partnerId for new room" });
    }

    const occ = occupancy == null || occupancy === "" ? null : Number(occupancy);
    const maxGuests = Number.isFinite(occ as number) ? (occ as number) : 2; // satisfies NOT NULL
    const basePrice = 0.0; // satisfies NOT NULL

    const { rows } = await client.query(
      `INSERT INTO ${T.rooms}
         ("partnerId","name","code","description","occupancy","maxGuests","basePrice","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7, NOW(), NOW())
       RETURNING "id","name","code","description","occupancy","maxGuests","basePrice"`,
      [partnerId, name.trim(), code ?? null, description ?? null, occ, maxGuests, basePrice]
    );

    await client.query("COMMIT");
    return res.status(201).json(rows[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[rooms:post] db error", e);
    return res.status(500).json({ error: "Create failed" });
  } finally {
    client.release();
  }
});

/** GET /:id/inventory?start=YYYY-MM-DD&end=YYYY-MM-DD */
r.get("/:id/inventory", async (req, res) => {
  try {
    const roomId = Number(req.params.id);
    const start = String(req.query.start || "");
    const end   = String(req.query.end   || "");
    const ds = parseDate(start);
    const de = parseDate(end);
    if (!roomId || !ds || !de) return res.status(400).json({ error: "bad params" });

    // prevent caching so UI sees fresh values after save
    res.set("Cache-Control", "no-store");

    // helpful server-side trace (shows up in Render logs)
    console.log("[inventory:get]", { roomId, start, end });

    const { rows } = await pool.query(
      `WITH days AS (
         SELECT generate_series($2::date, $3::date, '1 day')::date AS date
       )
       SELECT
         d.date,
         i."roomsOpen" AS "roomsOpen",   -- keep NULL as NULL (UI should treat lack of record as blank)
         i."minStay"   AS "minStay",
         i."isClosed"  AS "isClosed"
       FROM days d
       LEFT JOIN ${T.inv} i
         ON i."roomTypeId" = $1
        AND i."date"::date = d.date
       ORDER BY d.date ASC`,
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
    if (!roomId || !Array.isArray(items)) {
      return res.status(400).json({ error: "bad payload" });
    }

    // Resolve partnerId from the room type (authoritative)
    const roomRow = await client.query(
      `SELECT "partnerId" FROM ${T.rooms} WHERE "id" = $1`,
      [roomId]
    );
    const partnerId: number | null = roomRow.rows?.[0]?.partnerId ?? null;

    // Minimal context for runtime logs
    console.log(`[inventory:bulk] ctx roomId=${roomId} partnerId=${partnerId} items=${items.length}`);

    if (!partnerId) {
      return res.status(400).json({ error: "invalid roomTypeId (no partner)" });
    }

    await client.query("BEGIN");

    let upserted = 0;
    for (const it of items) {
      if (!it?.date || !parseDate(it.date)) continue;

      // NOT NULL-safe values
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

/** GET /:id/prices?start=YYYY-MM-DD&end=YYYY-MM-DD */
r.get("/:id/prices", async (req, res) => {
  try {
    const roomId = Number(req.params.id);
    const start = String(req.query.start || "");
    const end   = String(req.query.end   || "");
    const ds = parseDate(start);
    const de = parseDate(end);
    if (!roomId || !ds || !de) return res.status(400).json({ error: "bad params" });

    // prevent caching
    res.set("Cache-Control", "no-store");

    // pick plan (UI can send ?planId=...)
    const planId = Number(req.query.planId ?? 1);

    // helpful server-side trace (shows up in Render logs)
    console.log("[prices:get]", { roomId, start, end, planId });

    const { rows } = await pool.query(
      `WITH days AS (
         SELECT generate_series($2::date, $3::date, '1 day')::date AS date
       )
       SELECT
         d.date,
         $4::int              AS "ratePlanId",
         p."price"::numeric   AS "price"   -- keep NULL as NULL
       FROM days d
       LEFT JOIN ${T.prices} p
         ON p."roomTypeId" = $1
        AND p."date"::date  = d.date
        AND p."ratePlanId"  = $4
       ORDER BY d.date ASC`,
      [roomId, start, end, planId]
    );

    return res.json(rows);
  } catch (e) {
    console.error("[prices:get] db error", e);
    return res.status(500).json({ error: "Prices fetch failed" });
  }
});

/** GET /:id/snapshot?start=YYYY-MM-DD&end=YYYY-MM-DD&planId=1 */
r.get("/:id/snapshot", async (req, res) => {
  try {
    const roomId = Number(req.params.id);
    const start = String(req.query.start || "");
    const end   = String(req.query.end   || "");
    const ds = parseDate(start);
    const de = parseDate(end);
    if (!roomId || !ds || !de) return res.status(400).json({ error: "bad params" });

    res.set("Cache-Control", "no-store");
    const planId = Number(req.query.planId ?? 1);
    console.log("[snapshot:get]", { roomId, start, end, planId });

    const { rows: inv } = await pool.query(
      `WITH days AS (
         SELECT generate_series($2::date, $3::date, '1 day')::date AS date
       )
       SELECT d.date, i."roomsOpen", i."minStay", i."isClosed"
       FROM days d
       LEFT JOIN ${T.inv} i
         ON i."roomTypeId" = $1
        AND i."date"::date = d.date
       ORDER BY d.date ASC`,
      [roomId, start, end]
    );

    const { rows: prices } = await pool.query(
      `WITH days AS (
         SELECT generate_series($2::date, $3::date, '1 day')::date AS date
       )
       SELECT d.date, $4::int AS "ratePlanId", p."price"::numeric AS "price"
       FROM days d
       LEFT JOIN ${T.prices} p
         ON p."roomTypeId" = $1
        AND p."date"::date  = d.date
        AND p."ratePlanId"  = $4
       ORDER BY d.date ASC`,
      [roomId, start, end, planId]
    );

    return res.json({ inventory: inv, prices });
  } catch (e) {
    console.error("[snapshot:get] db error", e);
    return res.status(500).json({ error: "Snapshot fetch failed" });
  }
});

/** POST /:id/prices/bulk  { items:[{date,price,ratePlanId}] } */
r.post("/:id/prices/bulk", async (req, res) => {
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
    console.log("[prices:bulk] ctx", { roomId, partnerId, itemsPreview: Array.isArray(items) ? items.slice(0,3) : items });

    await client.query("BEGIN");

    let upserted = 0;
    for (const it of items) {
      if (!it?.date || !parseDate(it.date)) continue;
      const ratePlanId = Number(it.ratePlanId ?? 1);
      const price = Number(it.price ?? 0);

      await client.query(
        `INSERT INTO ${T.prices} ("partnerId","roomTypeId","date","ratePlanId","price","createdAt","updatedAt")
              VALUES ($1,$2,$3,$4,$5, NOW(), NOW())
         ON CONFLICT ("roomTypeId","date","ratePlanId")
           DO UPDATE SET "price" = EXCLUDED."price",
                         "updatedAt" = NOW()`,
        [partnerId, roomId, it.date, ratePlanId, price]
      );
      upserted++;
    }

    await client.query("COMMIT");
    return res.json({ ok: true, upserted });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[prices:bulk] db error", e);
    return res.status(500).json({ error: "Prices save failed" });
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
