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
      SELECT
        "id","name","code","description","occupancy","maxGuests","basePrice","active",
        "summary","size_sqm","size_sqft",
        "details_keys","details_text",
        "inclusion_keys","inclusion_text"
      FROM ${T.rooms}
      WHERE "partnerId" = $1
      ORDER BY "id" ASC
      `,
      [partnerId]
    );

    return res.status(200).json(rows);
  } catch (e) {
    console.error("[rooms:get] db error", e);
    return res.status(500).json({
      error: "Rooms list failed",
      detail: String(e),
    });
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
    const { 
      name, description, basePrice, maxGuests, occupancy, active,
      summary, size_sqm, size_sqft,
      details_keys, details_text,
      inclusion_keys, inclusion_text
    } = req.body ?? {};

    const sets: string[] = [];
    const vals: any[] = [id];
    let i = 2;

    if (typeof name === "string" && name.trim()) {
      sets.push(`"name"=$${i++}`); vals.push(name.trim());
    }
    
    // NEW FIELDS: summary
    if (typeof summary === "string") {
      sets.push(`"summary"=$${i++}`);
      vals.push(summary);
    }

    // NEW FIELDS: size_sqm / size_sqft
    if (size_sqm !== undefined && size_sqm !== null && String(size_sqm) !== "") {
      const sqm = Number(size_sqm);
      if (!Number.isFinite(sqm) || sqm < 0) {
        return res.status(400).json({ error: "bad size_sqm" });
      }
      sets.push(`"size_sqm"=$${i++}`); vals.push(sqm);
    }

    if (size_sqft !== undefined && size_sqft !== null && String(size_sqft) !== "") {
      const sqft = Number(size_sqft);
      if (!Number.isFinite(sqft) || sqft < 0) {
        return res.status(400).json({ error: "bad size_sqft" });
      }
      sets.push(`"size_sqft"=$${i++}`); vals.push(sqft);
    }

    // NEW FIELDS: details_keys / details_text
    if (Array.isArray(details_keys)) {
      sets.push(`"details_keys"=$${i++}`);
      vals.push(details_keys);
    }
    if (typeof details_text === "string") {
      sets.push(`"details_text"=$${i++}`);
      vals.push(details_text);
    }

    // NEW FIELDS: inclusion_keys / inclusion_text
    if (Array.isArray(inclusion_keys)) {
      sets.push(`"inclusion_keys"=$${i++}`);
      vals.push(inclusion_keys);
    }
    if (typeof inclusion_text === "string") {
      sets.push(`"inclusion_text"=$${i++}`);
      vals.push(inclusion_text);
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

    // --- Core fields ---
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

    // --- Room metadata (canonical: extranet."RoomType") ---
    if (Object.prototype.hasOwnProperty.call(b, "summary")) {
      if (b.summary !== null && typeof b.summary !== "string") {
        return res.status(400).json({ error: "bad summary" });
      }
      const s = (typeof b.summary === "string") ? b.summary.trim() : null;
      sets.push(`"summary"=$${i++}`); vals.push(s);
    }

    if (Object.prototype.hasOwnProperty.call(b, "details_text")) {
      if (b.details_text !== null && typeof b.details_text !== "string") {
        return res.status(400).json({ error: "bad details_text" });
      }
      const t = (typeof b.details_text === "string") ? b.details_text : null;
      sets.push(`"details_text"=$${i++}`); vals.push(t);
    }

    if (Object.prototype.hasOwnProperty.call(b, "inclusion_text")) {
      if (b.inclusion_text !== null && typeof b.inclusion_text !== "string") {
        return res.status(400).json({ error: "bad inclusion_text" });
      }
      const t = (typeof b.inclusion_text === "string") ? b.inclusion_text : null;
      sets.push(`"inclusion_text"=$${i++}`); vals.push(t);
    }

    if (Object.prototype.hasOwnProperty.call(b, "details_keys")) {
      if (b.details_keys !== null && !Array.isArray(b.details_keys)) {
        return res.status(400).json({ error: "bad details_keys" });
      }
      const arr = Array.isArray(b.details_keys)
        ? b.details_keys.map((x: any) => String(x)).filter(Boolean)
        : [];
      sets.push(`"details_keys"=$${i++}::text[]`); vals.push(arr);
    }

    if (Object.prototype.hasOwnProperty.call(b, "inclusion_keys")) {
      if (b.inclusion_keys !== null && !Array.isArray(b.inclusion_keys)) {
        return res.status(400).json({ error: "bad inclusion_keys" });
      }
      const arr = Array.isArray(b.inclusion_keys)
        ? b.inclusion_keys.map((x: any) => String(x)).filter(Boolean)
        : [];
      sets.push(`"inclusion_keys"=$${i++}::text[]`); vals.push(arr);
    }

    if (Object.prototype.hasOwnProperty.call(b, "size_sqm")) {
      if (b.size_sqm === null || b.size_sqm === "" || typeof b.size_sqm === "undefined") {
        sets.push(`"size_sqm"=$${i++}`); vals.push(null);
      } else {
        const v = Number(String(b.size_sqm).replace(/,/g, ""));
        if (!Number.isFinite(v) || v <= 0) {
          return res.status(400).json({ error: "bad size_sqm" });
        }
        sets.push(`"size_sqm"=$${i++}`); vals.push(v);
      }
    }

    if (Object.prototype.hasOwnProperty.call(b, "size_sqft")) {
      if (b.size_sqft === null || b.size_sqft === "" || typeof b.size_sqft === "undefined") {
        sets.push(`"size_sqft"=$${i++}`); vals.push(null);
      } else {
        const v = Number(String(b.size_sqft).replace(/,/g, ""));
        if (!Number.isFinite(v) || v <= 0) {
          return res.status(400).json({ error: "bad size_sqft" });
        }
        sets.push(`"size_sqft"=$${i++}`); vals.push(v);
      }
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

    if (!room.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Not found" });
    }

    if (authed && Number(room.rows[0].partnerId) !== Number(authed)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Forbidden" });
    }

    const upd = await client.query(
      `UPDATE ${T.rooms}
        SET ${sets.join(", ")}
      WHERE "id"=$1
      RETURNING
        "id","name","code","description","occupancy","maxGuests","basePrice","active",
        "summary","size_sqm","size_sqft","details_keys","details_text","inclusion_keys","inclusion_text"`,
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
  const client = await pool.connect();
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

    // 1) Resolve room partnerId + basePrice (+ active, for safety)
    const roomRow = await client.query(
      `SELECT "partnerId","basePrice","active"
         FROM ${T.rooms}
        WHERE "id" = $1
        LIMIT 1`,
      [roomId]
    );

    const partnerId = Number(roomRow.rows?.[0]?.partnerId);
    const baseRaw = roomRow.rows?.[0]?.basePrice;
    const basePrice = Number(String(baseRaw ?? "").replace(/[^0-9.]/g, ""));
    const isActive = roomRow.rows?.[0]?.active === true;

    if (!Number.isFinite(partnerId) || partnerId <= 0) {
      return res.status(400).json({ error: "invalid roomTypeId (no partner)" });
    }

    // Only seed if room is active and basePrice is valid (>0)
    const canSeed = isActive && Number.isFinite(basePrice) && basePrice > 0;

    // 2) Resolve this room's STD plan id
    let stdPlanId: number | null = null;
    if (canSeed) {
      const stdRow = await client.query(
        `SELECT "id"
           FROM ${T.ratePlans}
          WHERE "partnerId" = $1
            AND "roomTypeId" = $2
            AND (UPPER(COALESCE("code",'')) = 'STD' OR LOWER(COALESCE("name",'')) LIKE 'standard%')
          ORDER BY "id" ASC
          LIMIT 1`,
        [partnerId, roomId]
      );
      stdPlanId = stdRow.rows?.[0]?.id ?? null;
      stdPlanId = Number.isFinite(Number(stdPlanId)) ? Number(stdPlanId) : null;
    }

    // 3) Seed missing STD rows for the requested window when:
    // - caller requested STD explicitly, or
    // - caller requested no plan filter (calendar sometimes does this)
    const shouldSeedStd =
      canSeed &&
      stdPlanId != null &&
      (
        !Number.isFinite(planId) || Number(planId) === Number(stdPlanId)
      );

    if (shouldSeedStd && stdPlanId) {
      // Insert missing STD rows from basePrice for each date in [start, end]
      await client.query(
        `
        INSERT INTO ${T.prices}
          ("partnerId","roomTypeId","date","ratePlanId","price","createdAt","updatedAt")
        SELECT
          $1::int,
          $2::int,
          gs::date,
          $3::int,
          $4::numeric,
          NOW(),
          NOW()
        FROM generate_series($5::date, $6::date, INTERVAL '1 day') gs
        LEFT JOIN ${T.prices} p
          ON p."roomTypeId" = $2
         AND p."ratePlanId" = $3
         AND p."date" = gs::date
        WHERE p."id" IS NULL
        ON CONFLICT ("roomTypeId","date","ratePlanId")
          DO NOTHING
        `,
        [partnerId, roomId, stdPlanId, basePrice, start, end]
      );
    }

    // 4) Return prices (unchanged behavior)
    let rows;
    if (Number.isFinite(planId)) {
      const r2 = await client.query(
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
      rows = r2.rows;
    } else {
      const r2 = await client.query(
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
      rows = r2.rows;
    }

    return res.json(rows);
  } catch (e) {
    console.error("[prices:get] db error", e);
    return res.status(500).json({ error: "Prices fetch failed" });
  } finally {
    client.release();
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

    // Helper: normalize numeric price
    function normalizePrice(v: any): number {
      const n = Number(String(v).replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) && n >= 0 ? n : 0;
    }

    // 1) Validate all incoming ratePlanIds belong to this partner + roomType
    const planIds = Array.from(
      new Set(
        items
          .map((x: any) => Number(x?.ratePlanId))
          .filter((x: any) => Number.isFinite(x) && x > 0)
      )
    );

    if (planIds.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "items must include a valid ratePlanId" });
    }

    const planCheck = await client.query(
      `SELECT "id","code","name"
         FROM ${T.ratePlans}
        WHERE "partnerId" = $1
          AND "roomTypeId" = $2
          AND "id" = ANY($3::int[])`,
      [partnerId, roomId, planIds]
    );

    if (planCheck.rowCount !== planIds.length) {
      const found = new Set((planCheck.rows || []).map((r: any) => Number(r.id)));
      const missing = planIds.filter((id: number) => !found.has(id));
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "invalid ratePlanId for this roomType",
        missingRatePlanIds: missing,
      });
    }

    // 2) Identify the room's STD plan id (by code STD if present, else name starts with Standard)
    const stdPlanRow = await client.query(
      `SELECT "id"
         FROM ${T.ratePlans}
        WHERE "partnerId" = $1
          AND "roomTypeId" = $2
          AND (UPPER(COALESCE("code",'')) = 'STD' OR LOWER(COALESCE("name",'')) LIKE 'standard%')
        ORDER BY "id" ASC
        LIMIT 1`,
      [partnerId, roomId]
    );

    const stdPlanId: number | null = stdPlanRow.rows?.[0]?.id ?? null;

    // Also fetch basePrice for seeding
    const baseRow = await client.query(
      `SELECT "basePrice" FROM ${T.rooms} WHERE "id" = $1`,
      [roomId]
    );
    const basePrice = normalizePrice(baseRow.rows?.[0]?.basePrice ?? 0);

    // Collect unique dates in this payload
    const dates = Array.from(
      new Set(
        items
          .map((x: any) => String(x?.date || ""))
          .filter((d: string) => !!parseDate(d))
      )
    );

    // 3) Backend seeding: if writing any non-STD plan for these dates, ensure STD rows exist
    const hasNonStdWrite =
      stdPlanId != null && planIds.some((id: number) => Number(id) !== Number(stdPlanId));

    if (hasNonStdWrite && stdPlanId) {
      // Which STD dates are missing?
      const existingStd = await client.query(
        `SELECT (p."date")::date AS "date"
           FROM ${T.prices} p
          WHERE p."partnerId" = $1
            AND p."roomTypeId" = $2
            AND p."ratePlanId" = $3
            AND p."date" = ANY($4::date[])`,
        [partnerId, roomId, stdPlanId, dates]
      );

      const have = new Set((existingStd.rows || []).map((r: any) => String(r.date)));
      const missingDates = dates.filter((d: string) => !have.has(d));

      for (const d of missingDates) {
        await client.query(
          `INSERT INTO ${T.prices}
             ("partnerId","roomTypeId","date","ratePlanId","price","createdAt","updatedAt")
           VALUES ($1,$2,$3::date,$4,$5,NOW(),NOW())
           ON CONFLICT ("roomTypeId","date","ratePlanId")
             DO UPDATE SET "price" = EXCLUDED."price",
                           "updatedAt" = NOW()`,
          [partnerId, roomId, d, stdPlanId, basePrice]
        );
      }
    }

    // 4) Upsert items exactly under their own ratePlanId (no rewriting)
    let upserted = 0;
    for (const it of items) {
      if (!it?.date || !parseDate(it.date)) continue;

      const rpId = Number(it.ratePlanId);
      if (!Number.isFinite(rpId) || rpId <= 0) continue;

      const price = normalizePrice(it.price);

      await client.query(
        `INSERT INTO ${T.prices}
           ("partnerId","roomTypeId","date","ratePlanId","price","createdAt","updatedAt")
         VALUES ($1,$2,$3::date,$4,$5,NOW(),NOW())
         ON CONFLICT ("roomTypeId","date","ratePlanId")
           DO UPDATE SET "price" = EXCLUDED."price",
                         "updatedAt" = NOW()`,
        [partnerId, roomId, it.date, rpId, price]
      );
      upserted++;
    }

    await client.query("COMMIT");
    return res.json({ ok: true, upserted });
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
