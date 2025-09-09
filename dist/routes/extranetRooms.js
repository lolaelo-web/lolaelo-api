import { Router } from "express";
import { Pool } from "pg";
const r = Router();
// ---- Helpers ----
function wantsSSL(cs) {
    return /\bsslmode=require\b/i.test(cs) || /render\.com/i.test(cs);
}
function parseDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s))
        return null;
    const d = new Date(s + "T00:00:00Z");
    return Number.isNaN(d.getTime()) ? null : d;
}
function authedPartnerId(req) {
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
    rooms: `extranet."RoomType"`,
    inv: `extranet."RoomInventory"`,
    prices: `extranet."RoomPrice"`,
};
/** GET /extranet/property/rooms */
r.get("/", async (_req, res) => {
    try {
        res.set("Cache-Control", "no-store");
        const { rows } = await pool.query(`
      SELECT "id","name","code","description","occupancy","maxGuests","basePrice"
      FROM ${T.rooms}
      ORDER BY "id" ASC
    `);
        return res.status(200).json(rows);
    }
    catch (e) {
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
        let partnerId = req.partner?.id ?? req.partnerId ?? null;
        if (!partnerId) {
            const probe = await client.query(`SELECT "partnerId" FROM ${T.rooms} ORDER BY "id" ASC LIMIT 1`);
            partnerId = probe.rows?.[0]?.partnerId ?? null;
        }
        if (!partnerId) {
            await client.query("ROLLBACK");
            return res
                .status(400)
                .json({ error: "unable to determine partnerId for new room" });
        }
        const occ = occupancy == null || occupancy === "" ? null : Number(occupancy);
        const maxGuests = Number.isFinite(occ) ? occ : 2; // satisfies NOT NULL
        const basePrice = 0.0; // satisfies NOT NULL
        const { rows } = await client.query(`INSERT INTO ${T.rooms}
         ("partnerId","name","code","description","occupancy","maxGuests","basePrice","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7, NOW(), NOW())
       RETURNING "id","name","code","description","occupancy","maxGuests","basePrice"`, [
            partnerId,
            name.trim(),
            code ?? null,
            description ?? null,
            occ,
            maxGuests,
            basePrice,
        ]);
        await client.query("COMMIT");
        return res.status(201).json(rows[0]);
    }
    catch (e) {
        await client.query("ROLLBACK");
        console.error("[rooms:post] db error", e);
        return res.status(500).json({ error: "Create failed" });
    }
    finally {
        client.release();
    }
});
/** PUT /extranet/property/rooms/:id  (rename only) */
r.put("/:id", async (req, res) => {
    const client = await pool.connect();
    try {
        const id = Number(req.params.id);
        const { name } = req.body ?? {};
        if (!Number.isFinite(id) || id <= 0)
            return res.status(400).json({ error: "invalid id" });
        if (!name || typeof name !== "string")
            return res.status(400).json({ error: "name is required" });
        const authed = authedPartnerId(req);
        await client.query("BEGIN");
        const room = await client.query(`SELECT "id","partnerId" FROM ${T.rooms} WHERE "id"=$1`, [id]);
        if (room.rowCount === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "Not found" });
        }
        const owner = Number(room.rows[0].partnerId);
        if (Number.isFinite(authed) && authed !== owner) {
            await client.query("ROLLBACK");
            return res.status(403).json({ error: "Forbidden" });
        }
        const upd = await client.query(`UPDATE ${T.rooms}
          SET "name"=$2, "updatedAt"=NOW()
        WHERE "id"=$1
      RETURNING "id","name","code","description","occupancy","maxGuests","basePrice"`, [id, name.trim()]);
        await client.query("COMMIT");
        return res.status(200).json(upd.rows[0]);
    }
    catch (e) {
        await client.query("ROLLBACK");
        console.error("[rooms:put] db error", e);
        return res.status(500).json({ error: "Update failed" });
    }
    finally {
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
        const { rows } = await pool.query(`SELECT
         (i."date")::date AS "date",
         i."roomsOpen"    AS "roomsOpen",
         i."minStay"      AS "minStay",
         i."isClosed"     AS "isClosed"
       FROM ${T.inv} i
       WHERE i."roomTypeId" = $1
         AND i."date" >= $2::date
         AND i."date" <  ($3::date + INTERVAL '1 day')
       ORDER BY i."date" ASC`, [roomId, start, end]);
        return res.json(rows);
    }
    catch (e) {
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
        if (!roomId || !Array.isArray(items))
            return res.status(400).json({ error: "bad payload" });
        // Resolve partnerId from the room type (authoritative)
        const roomRow = await client.query(`SELECT "partnerId" FROM ${T.rooms} WHERE "id"=$1`, [roomId]);
        const partnerId = roomRow.rows?.[0]?.partnerId ?? null;
        if (!partnerId)
            return res.status(400).json({ error: "invalid roomTypeId (no partner)" });
        await client.query("BEGIN");
        let upserted = 0;
        for (const it of items) {
            if (!it?.date || !parseDate(it.date))
                continue;
            // Which fields were provided?
            const providedOpen = Object.prototype.hasOwnProperty.call(it, "roomsOpen");
            const providedStay = Object.prototype.hasOwnProperty.call(it, "minStay");
            const providedClosed = Object.prototype.hasOwnProperty.call(it, "isClosed");
            // Normalize values only if provided
            const roomsOpenNum = Number(it.roomsOpen);
            const roomsOpen = providedOpen && Number.isFinite(roomsOpenNum) && roomsOpenNum >= 0
                ? Math.floor(roomsOpenNum)
                : 0; // used only when provided or on insert
            const minStayNum = Number(it.minStay);
            const minStay = providedStay && Number.isFinite(minStayNum) && minStayNum >= 1
                ? Math.floor(minStayNum)
                : null; // used only when provided or on insert
            const isClosed = providedClosed ? Boolean(it.isClosed) : false;
            // Does a row already exist for this calendar day?
            const ex = await client.query(`SELECT 1
           FROM ${T.inv}
          WHERE "roomTypeId" = $1
            AND "date" >= $2::date
            AND "date" <  ($2::date + INTERVAL '1 day')`, [roomId, it.date]);
            if (Number(ex.rowCount ?? 0) > 0) {
                // UPDATE only provided fields (match by day, not timestamp)
                const sets = [];
                const vals = [roomId, it.date];
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
                    await client.query(`UPDATE ${T.inv}
                SET ${sets.join(", ")}
              WHERE "roomTypeId" = $1
                AND "date" >= $2::date
                AND "date" <  ($2::date + INTERVAL '1 day')`, vals);
                }
            }
            else {
                // INSERT new row; normalize "date" to DATE (no time)
                await client.query(`INSERT INTO ${T.inv}
             ("partnerId","roomTypeId","date","roomsOpen","minStay","isClosed","createdAt","updatedAt")
           VALUES ($1,$2,$3::date,$4,$5,$6,NOW(),NOW())`, [partnerId, roomId, it.date, roomsOpen, minStay, isClosed]);
            }
            upserted++;
        }
        await client.query("COMMIT");
        return res.json({ ok: true, upserted });
    }
    catch (e) {
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
    }
    finally {
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
        if (!roomId || !ds || !de)
            return res.status(400).json({ error: "bad params" });
        res.set("Cache-Control", "no-store");
        const planId = Number(req.query.planId ?? 1);
        const { rows } = await pool.query(`SELECT
         (p."date")::date      AS "date",
         $4::int               AS "ratePlanId",
         (p."price")::numeric  AS "price"
       FROM ${T.prices} p
       WHERE p."roomTypeId" = $1
         AND p."ratePlanId" = $4
         AND p."date" >= $2::date
         AND p."date" <  ($3::date + INTERVAL '1 day')
       ORDER BY p."date" ASC`, [roomId, start, end, planId]);
        return res.json(rows);
    }
    catch (e) {
        console.error("[prices:get] db error", e);
        return res.status(500).json({ error: "Prices fetch failed" });
    }
});
/** GET /:id/snapshot?start=YYYY-MM-DD&end=YYYY-MM-DD&planId=1 */
r.get("/:id/snapshot", async (req, res) => {
    try {
        const roomId = Number(req.params.id);
        const start = String(req.query.start || "");
        const end = String(req.query.end || "");
        const ds = parseDate(start);
        const de = parseDate(end);
        if (!roomId || !ds || !de)
            return res.status(400).json({ error: "bad params" });
        res.set("Cache-Control", "no-store");
        const planId = Number(req.query.planId ?? 1);
        const { rows: inv } = await pool.query(`SELECT (i."date")::date AS date, i."roomsOpen", i."minStay", i."isClosed"
         FROM ${T.inv} i
        WHERE i."roomTypeId" = $1
          AND i."date" >= $2::date
          AND i."date" <  ($3::date + INTERVAL '1 day')
        ORDER BY i."date" ASC`, [roomId, start, end]);
        const { rows: prices } = await pool.query(`SELECT (p."date")::date AS date, $4::int AS "ratePlanId", (p."price")::numeric AS "price"
         FROM ${T.prices} p
        WHERE p."roomTypeId" = $1
          AND p."ratePlanId" = $4
          AND p."date" >= $2::date
          AND p."date" <  ($3::date + INTERVAL '1 day')
        ORDER BY p."date" ASC`, [roomId, start, end, planId]);
        return res.json({ inventory: inv, prices });
    }
    catch (e) {
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
        if (!roomId || !Array.isArray(items))
            return res.status(400).json({ error: "bad payload" });
        // Resolve partnerId from the room type (authoritative)
        const roomRow = await client.query(`SELECT "partnerId" FROM ${T.rooms} WHERE "id" = $1`, [roomId]);
        const partnerId = roomRow.rows?.[0]?.partnerId ?? null;
        if (!partnerId)
            return res.status(400).json({ error: "invalid roomTypeId (no partner)" });
        await client.query("BEGIN");
        let upserted = 0;
        for (const it of items) {
            if (!it?.date || !parseDate(it.date))
                continue;
            const ratePlanId = Number(it.ratePlanId ?? 1);
            const priceNum = Number(it.price);
            const price = Number.isFinite(priceNum) ? priceNum : 0;
            await client.query(`INSERT INTO ${T.prices}
           ("partnerId","roomTypeId","date","ratePlanId","price","createdAt","updatedAt")
         VALUES ($1,$2,$3::date,$4,$5,NOW(),NOW())
         ON CONFLICT ("roomTypeId","date","ratePlanId")
           DO UPDATE SET "price" = EXCLUDED."price",
                         "updatedAt" = NOW()`, [partnerId, roomId, it.date, ratePlanId, price]);
            upserted++;
        }
        await client.query("COMMIT");
        return res.json({ ok: true, upserted });
    }
    catch (e) {
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
        return res.status(500).json({
            error: "Prices save failed",
            code: e?.code ?? null,
            detail: e?.detail ?? null,
            constraint: e?.constraint ?? null,
            where: e?.where ?? null,
        });
    }
    finally {
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
        const room = await client.query(`SELECT "id","partnerId" FROM ${T.rooms} WHERE "id"=$1`, [id]);
        if (room.rowCount === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "Not found" });
        }
        const owner = Number(room.rows[0].partnerId);
        if (Number.isFinite(authed) && authed !== owner) {
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
    }
    catch (e) {
        await client.query("ROLLBACK");
        console.error("[rooms:delete] db error", e);
        return res.status(500).json({ error: "Delete failed" });
    }
    finally {
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
    }
    catch (e) {
        res.json({ ok: false, bootId: BOOT_ID, dbError: String(e) });
    }
});
export default r;
