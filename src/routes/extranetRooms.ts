import { Router } from "express";
import { Pool } from "pg";
import { authPartnerFromHeader, getSession } from "../session.js";

const r = Router();

// Always attach req.partner { id, email, name } from the session token
r.use(authPartnerFromHeader);

// ---- Helpers ----
function wantsSSL(cs: string): boolean {
  return /\bsslmode=require\b/i.test(cs) || /render\.com/i.test(cs);
}
function parseDate(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : d;
}
function authedPartnerId(req: any): number | null {
  const v = Number(req?.partner?.id) ?? Number(req?.partnerId);
  return Number.isFinite(v) ? v : null;
}

// ---- PG pool (conditional SSL) ----
const cs = process.env.DATABASE_URL || "";
const pool = new Pool({
  connectionString: cs,
  ssl: wantsSSL(cs) ? { rejectUnauthorized: false } : undefined,
});

// Table names
const T = {
  rooms:      `extranet."RoomType"`,
  inv:        `extranet."RoomInventory"`,
  prices:     `extranet."RoomPrice"`,
  ratePlans:  `extranet."RatePlan"`,
};

/** GET /extranet/property/rooms */
r.get("/", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");

    // partner guard (auth middleware set this earlier)
    const partnerId = Number((req as any)?.partner?.id);
    if (!Number.isFinite(partnerId) || partnerId <= 0) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { rows } = await pool.query(
      `
      SELECT "id","name","code","description","occupancy","maxGuests","basePrice","active"
      FROM ${T.rooms}
      WHERE "partnerId" = $1
      ORDER BY "id" ASC
      `,
      [partnerId]
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
    const { name, code, description, occupancy, active } = req.body ?? {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }

    await client.query("BEGIN");

    // Derive partnerId strictly from authenticated session (no cross-tenant fallback)
    let partnerId: number | null = authedPartnerId(req);

    if (!partnerId) {
      // Fallback: resolve via bearer token -> session -> partnerId (no DB guessing)
      const hdr = String(req.headers["authorization"] || "");
      const bearer = hdr.startsWith("Bearer ")
        ? hdr.slice(7)
        : String(req.headers["x-partner-token"] || "");
      try {
        const s = await getSession(bearer);
        partnerId = Number((s as any)?.partnerId) || null;
      } catch {
        partnerId = null;
      }
    }

    if (!partnerId) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "unable to determine partnerId for new room" });
    }

    const occ =
      occupancy == null || occupancy === "" ? null : Number(occupancy);
    const maxGuests = Number.isFinite(occ as number) ? (occ as number) : 2; // satisfies NOT NULL
    const basePrice = 0.0; // satisfies NOT NULL
    const activeVal =
      active === true ||
      active === "true" ||
      active === 1 ||
      active === "1" ||
      false;

    const { rows } = await client.query(
      `INSERT INTO ${T.rooms}
         ("partnerId","name","code","description","occupancy","maxGuests","basePrice","active","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW(), NOW())
       RETURNING "id","name","code","description","occupancy","maxGuests","basePrice","active"`,
      [
        partnerId,
        name.trim(),
        code ?? null,
        description ?? null,
        occ,
        maxGuests,
        basePrice,
        activeVal,
      ]
    );
    // ensure a default 'Standard' rate plan exists for this new room
    const newRoomId = Number(rows[0]?.id);
    if (Number.isFinite(newRoomId)) {
      const rpCheck = await client.query(
        `SELECT 1 FROM ${T.ratePlans} WHERE "roomTypeId" = $1 LIMIT 1`,
        [newRoomId]
      );
      if (rpCheck.rowCount === 0) {
        await client.query(
          `INSERT INTO ${T.ratePlans}
            ("partnerId","roomTypeId","name","createdAt","updatedAt")
          VALUES ($1,$2,$3,NOW(),NOW())`,
          [partnerId, newRoomId, "Standard"]
        );
      }
    }

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

/** PUT /extranet/property/rooms/:id  (update name/basePrice/capacity/active) */
r.put("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }

    // Accept any subset: name, description, basePrice, maxGuests/occupancy, active
    const { name, description, basePrice, maxGuests, occupancy, active } = req.body ?? {};
    const sets: string[] = [];
    const vals: any[] = [id];
    let i = 2;

    if (typeof name === "string" && name.trim()) {
      sets.push(`"name"=$${i++}`); vals.push(name.trim());
    }
    if (typeof description === "string") {
      sets.push(`"description"=$${i++}`); vals.push(description);
    }
    if (basePrice !== undefined && basePrice !== null && String(basePrice) !== "") {
      const bp = Number(String(basePrice).replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(bp) || bp < 0) {
        return res.status(400).json({ error: "bad basePrice" });
      }
      sets.push(`"basePrice"=$${i++}`); vals.push(bp.toFixed(2));
    }
    const cap = (maxGuests ?? occupancy);
    if (cap !== undefined && cap !== null && String(cap) !== "") {
      const cg = Number(cap);
      if (!Number.isFinite(cg) || cg < 1) {
        return res.status(400).json({ error: "bad capacity" });
      }
      sets.push(`"maxGuests"=$${i++}`); vals.push(cg);
      sets.push(`"occupancy"=$${i++}`); vals.push(cg);
    }
    if (active !== undefined) {
      const av =
        active === true || active === "true" || active === 1 || active === "1";
      sets.push(`"active"=$${i++}`); vals.push(av);
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: "no fields" });
    }
    sets.push(`"updatedAt"=NOW()`);

    const authed = authedPartnerId(req);

    await client.query("BEGIN");

    const room = await client.query(
      `SELECT "id","partnerId" FROM ${T.rooms} WHERE "id"=$1`,
      [id]
    );
    if (room.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Not found" });
    }
    const owner = Number(room.rows[0].partnerId);
    if (Number.isFinite(authed!) && authed !== owner) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Forbidden" });
    }

    const upd = await client.query(
      `UPDATE ${T.rooms}
         SET ${sets.join(", ")}
       WHERE "id"=$1
       RETURNING "id","name","code","description","occupancy","maxGuests","basePrice","active"`,
      vals
    );

    await client.query("COMMIT");
    return res.status(200).json(upd.rows[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[rooms:put] db error", e);
    return res.status(500).json({ error: "Update failed" });
  } finally {
    client.release();
  }
});

/** PATCH /extranet/property/rooms/:id  (partial update, incl. active) */
r.patch("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }

    const b = req.body ?? {};
    const sets: string[] = [];
    const vals: any[] = [id];
    let i = 2;

    if (Object.prototype.hasOwnProperty.call(b, "name")) {
      if (typeof b.name !== "string" || !b.name.trim()) {
        return res.status(400).json({ error: "bad name" });
      }
      sets.push(`"name"=$${i++}`); vals.push(b.name.trim());
    }
    if (Object.prototype.hasOwnProperty.call(b, "description")) {
      if (typeof b.description !== "string") {
        return res.status(400).json({ error: "bad description" });
      }
      sets.push(`"description"=$${i++}`); vals.push(b.description);
    }
    if (Object.prototype.hasOwnProperty.call(b, "basePrice")) {
      if (b.basePrice === null || String(b.basePrice) === "") {
        return res.status(400).json({ error: "bad basePrice" });
      }
      const bp = Number(String(b.basePrice).replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(bp) || bp < 0) {
        return res.status(400).json({ error: "bad basePrice" });
      }
      sets.push(`"basePrice"=$${i++}`); vals.push(bp.toFixed(2));
    }
    if (
      Object.prototype.hasOwnProperty.call(b, "maxGuests") ||
      Object.prototype.hasOwnProperty.call(b, "occupancy")
    ) {
      const cap = (b.maxGuests ?? b.occupancy);
      const cg = Number(cap);
      if (!Number.isFinite(cg) || cg < 1) {
        return res.status(400).json({ error: "bad capacity" });
      }
      sets.push(`"maxGuests"=$${i++}`); vals.push(cg);
      sets.push(`"occupancy"=$${i++}`); vals.push(cg);
    }
    if (Object.prototype.hasOwnProperty.call(b, "active")) {
      const av =
        b.active === true || b.active === "true" || b.active === 1 || b.active === "1";
      sets.push(`"active"=$${i++}`); vals.push(av);
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: "no fields" });
    }
    sets.push(`"updatedAt"=NOW()`);

    const authed = authedPartnerId(req);

    await client.query("BEGIN");

    const room = await client.query(
      `SELECT "id","partnerId" FROM ${T.rooms} WHERE "id"=$1`,
      [id]
    );
    if (room.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Not found" });
    }
    const owner = Number(room.rows[0].partnerId);
    if (Number.isFinite(authed!) && authed !== owner) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Forbidden" });
    }

    const upd = await client.query(
      `UPDATE ${T.rooms}
         SET ${sets.join(", ")}
       WHERE "id"=$1
       RETURNING "id","name","code","description","occupancy","maxGuests","basePrice","active"`,
      vals
    );

    await client.query("COMMIT");
    return res.status(200).json(upd.rows[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[rooms:patch] db error", e);
    return res.status(500).json({ error: "Update failed" });
  } finally {
    client.release();
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
    if (!roomId || !ds || !de)
      return res.status(400).json({ error: "bad params" });

    res.set("Cache-Control", "no-store");

    const { rows } = await pool.query(
      `SELECT
         (i."date")::date AS "date",
         i."roomsOpen"    AS "roomsOpen",
         i."minStay"      AS "minStay",
         i."isClosed"     AS "isClosed"
       FROM ${T.inv} i
       WHERE i."roomTypeId" = $1
         AND i."date" >= $2::date
         AND i."date" <  ($3::date + INTERVAL '1 day')
       ORDER BY i."date" ASC`,
      [roomId, start, end]
    );

    return res.json(rows);
  } catch (e) {
    console.error("[inventory:get] db error", e);
    return res.status(500).json({ error: "Inventory fetch failed" });
  }
});

/** POST /:id/inventory/bulk  { items:[{date,roomsOpen?,minStay?,isClosed?}] } */
r.post("/:id/inventory/bulk", async (req, res) => {
  const client = await pool.connect();
  try {
    const roomId = Number(req.params.id);
    const { items } = req.body ?? {};
    if (!roomId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "bad payload: items required" });
    }
    // Resolve partnerId from the room type (authoritative)
    const roomRow = await client.query(
      `SELECT "partnerId" FROM ${T.rooms} WHERE "id"=$1`,
      [roomId]
    );
    const partnerId: number | null = roomRow.rows?.[0]?.partnerId ?? null;
    if (!partnerId)
      return res.status(400).json({ error: "invalid roomTypeId (no partner)" });

    await client.query("BEGIN");

    let upserted = 0;
    for (const it of items) {
      if (!it?.date || !parseDate(it.date)) continue;

      // Which fields were provided?
      const providedOpen = Object.prototype.hasOwnProperty.call(
        it,
        "roomsOpen"
      );
      const providedStay = Object.prototype.hasOwnProperty.call(it, "minStay");
      const providedClosed = Object.prototype.hasOwnProperty.call(
        it,
        "isClosed"
      );

      // Normalize values only if provided
      const roomsOpenNum = Number(it.roomsOpen);
      const roomsOpen =
        providedOpen && Number.isFinite(roomsOpenNum) && roomsOpenNum >= 0
          ? Math.floor(roomsOpenNum)
          : 0; // used only when provided or on insert

      const minStayNum = Number(it.minStay);
      const minStay =
        providedStay && Number.isFinite(minStayNum) && minStayNum >= 1
          ? Math.floor(minStayNum)
          : null; // used only when provided or on insert

      const isClosed = providedClosed ? Boolean(it.isClosed) : false;

      // Does a row already exist for this calendar day?
      const ex = await client.query(
        `SELECT 1
           FROM ${T.inv}
          WHERE "roomTypeId" = $1
            AND "date" >= $2::date
            AND "date" <  ($2::date + INTERVAL '1 day')`,
        [roomId, it.date]
      );

      if (Number(ex.rowCount ?? 0) > 0) {
        // UPDATE only provided fields (match by day, not timestamp)
        const sets: string[] = [];
        const vals: any[] = [roomId, it.date];
        let i = 3;

        if (providedOpen) {
          sets.push(`"roomsOpen" = $${i++}`);
          vals.push(roomsOpen);
        }
        if (providedStay) {
          sets.push(`"minStay"   = $${i++}`);
          vals.push(minStay);
        }
        if (providedClosed) {
          sets.push(`"isClosed"  = $${i++}`);
          vals.push(isClosed);
        }

        if (sets.length > 0) {
          sets.push(`"updatedAt" = NOW()`);
          await client.query(
            `UPDATE ${T.inv}
                SET ${sets.join(", ")}
              WHERE "roomTypeId" = $1
                AND "date" >= $2::date
                AND "date" <  ($2::date + INTERVAL '1 day')`,
            vals
          );
        }
      } else {
        // INSERT new row; normalize "date" to DATE (no time)
        await client.query(
          `INSERT INTO ${T.inv}
             ("partnerId","roomTypeId","date","roomsOpen","minStay","isClosed","createdAt","updatedAt")
           VALUES ($1,$2,$3::date,$4,$5,$6,NOW(),NOW())`,
          [partnerId, roomId, it.date, roomsOpen, minStay, isClosed]
        );
      }
      upserted++;
    }

    await client.query("COMMIT");
    return res.json({ ok: true, upserted });
  } catch (e: any) {
    await client.query("ROLLBACK");
    console.error("[inventory:bulk] db error", {
      message: e?.message,
      code: e?.code,
      detail: e?.detail,
      constraint: e?.constraint,
      table: e?.table,
      where: e?.where,
      stack: e?.stack,
    });
    return res
      .status(500)
      .json({ error: "Inventory save failed", code: e?.code ?? null });
  } finally {
    client.release();
  }
});

/** GET /:id/prices?start=YYYY-MM-DD&end=YYYY-MM-DD[&ratePlanId=INT] */
r.get("/:id/prices", async (req, res) => {
  try {
    const roomId = Number(req.params.id);
    const start  = String(req.query.start || "");
    const end    = String(req.query.end   || "");
    const ds = parseDate(start);
    const de = parseDate(end);
    if (!roomId || !ds || !de) {
      return res.status(400).json({ error: "bad params" });
    }

    res.set("Cache-Control", "no-store");

    // Accept either ?ratePlanId= or legacy ?planId=
    const planQ  = (req.query as any).ratePlanId ?? (req.query as any).planId;
    const planId = planQ != null && String(planQ) !== "" ? Number(planQ) : NaN;

    let rows;
    if (Number.isFinite(planId)) {
      // Filter by a specific plan
      const r = await pool.query(
        `SELECT
           (p."date")::date     AS "date",
           p."ratePlanId"       AS "ratePlanId",
           (p."price")::numeric AS "price"
         FROM ${T.prices} p
         WHERE p."roomTypeId" = $1
           AND p."ratePlanId"  = $4
           AND p."date" >= $2::date
           AND p."date" <  ($3::date + INTERVAL '1 day')
         ORDER BY p."date" ASC`,
        [roomId, start, end, planId]
      );
      rows = r.rows;
    } else {
      // No plan filter → return all plans in the range
      const r = await pool.query(
        `SELECT
           (p."date")::date     AS "date",
           p."ratePlanId"       AS "ratePlanId",
           (p."price")::numeric AS "price"
         FROM ${T.prices} p
         WHERE p."roomTypeId" = $1
           AND p."date" >= $2::date
           AND p."date" <  ($3::date + INTERVAL '1 day')
         ORDER BY p."date" ASC`,
        [roomId, start, end]
      );
      rows = r.rows;
    }

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
    if (!roomId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "bad payload: items required" });
    }

    // Resolve partnerId from the room type (authoritative)
    const roomRow = await client.query(
      `SELECT "partnerId" FROM ${T.rooms} WHERE "id" = $1`,
      [roomId]
    );
    const partnerId: number | null = roomRow.rows?.[0]?.partnerId ?? null;
    if (!partnerId) {
      return res.status(400).json({ error: "invalid roomTypeId (no partner)" });
    }

    await client.query("BEGIN");

    // Resolve a usable rate plan:
    // - prefer the client-sent ratePlanId if it exists for this room
    // - else try a 'Standard' plan for this partner/room
    // - else create a 'Standard' plan and use it
    let requestedPlanId = Number(items?.[0]?.ratePlanId ?? 1);
    if (!Number.isFinite(requestedPlanId) || requestedPlanId <= 0) {
      requestedPlanId = 1;
    }

    let planIdRow = await client.query(
      `SELECT "id"
         FROM extranet."RatePlan"
        WHERE "partnerId" = $1
          AND "roomTypeId" = $2
          AND ("id" = $3 OR LOWER("name") LIKE 'standard%')
        ORDER BY "id" ASC
        LIMIT 1`,
      [partnerId, roomId, requestedPlanId]
    );

    let finalPlanId: number | null = planIdRow.rows?.[0]?.id ?? null;

    if (!finalPlanId) {
      const newPlan = await client.query(
        `INSERT INTO extranet."RatePlan"
           ("partnerId","roomTypeId","name","createdAt","updatedAt")
         VALUES ($1,$2,$3,NOW(),NOW())
         RETURNING "id"`,
        [partnerId, roomId, "Standard"]
      );
      finalPlanId = Number(newPlan.rows[0].id);
    }

    let upserted = 0;
    for (const it of items) {
      if (!it?.date || !parseDate(it.date)) continue;

      // price: normalize to numeric (two-decimals later in DB as NUMERIC)
      const priceNum = Number(String(it.price).replace(/[^0-9.]/g, ""));
      const price = Number.isFinite(priceNum) && priceNum >= 0 ? priceNum : 0;

      await client.query(
        `INSERT INTO ${T.prices}
           ("partnerId","roomTypeId","date","ratePlanId","price","createdAt","updatedAt")
         VALUES ($1,$2,$3::date,$4,$5,NOW(),NOW())
         ON CONFLICT ("roomTypeId","date","ratePlanId")
           DO UPDATE SET "price" = EXCLUDED."price",
                         "updatedAt" = NOW()`,
        [partnerId, roomId, it.date, finalPlanId, price]
      );
      upserted++;
    }

    await client.query("COMMIT");
    return res.json({ ok: true, upserted, ratePlanId: finalPlanId });
  } catch (e: any) {
    await client.query("ROLLBACK");
    console.error("[prices:bulk] db error", {
      message: e?.message,
      code: e?.code,
      detail: e?.detail,
      constraint: e?.constraint,
      table: e?.table,
      where: e?.where,
      stack: e?.stack,
    });
    const msg =
      e?.code === "23503"
        ? "Prices save failed (missing RatePlan FK)"
        : "Prices save failed";
    return res.status(500).json({
      error: msg,
      code: e?.code ?? null,
      detail: e?.detail ?? null,
      constraint: e?.constraint ?? null,
      where: e?.where ?? null,
    });
  } finally {
    client.release();
  }
});

/** DELETE /extranet/property/rooms/:id */
r.delete("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0)
      return res.status(400).json({ error: "invalid id" });

    const authed = authedPartnerId(req);

    await client.query("BEGIN");

    const room = await client.query(
      `SELECT "id","partnerId" FROM ${T.rooms} WHERE "id"=$1`,
      [id]
    );
    if (room.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Not found" });
    }
    const owner = Number(room.rows[0].partnerId);
    if (Number.isFinite(authed!) && authed !== owner) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Forbidden" });
    }

    // delete children first (if FKs are not ON DELETE CASCADE)
    await client.query(`DELETE FROM ${T.inv}    WHERE "roomTypeId" = $1`, [
      id,
    ]);
    await client.query(`DELETE FROM ${T.prices} WHERE "roomTypeId" = $1`, [
      id,
    ]);

    await client.query(`DELETE FROM ${T.rooms} WHERE "id" = $1`, [id]);

    await client.query("COMMIT");
    return res.status(204).end();
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[rooms:delete] db error", e);
    return res.status(500).json({ error: "Delete failed" });
  } finally {
    client.release();
  }
});

// Debug
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
