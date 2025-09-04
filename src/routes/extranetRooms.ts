import { Router } from "express";

const r = Router();

/**
 * In-memory stub so UI can function end-to-end without DB crashes.
 * - GET /extranet/property/rooms           → list rooms
 * - POST /extranet/property/rooms          → create room
 * - GET  /extranet/property/rooms/:id/inventory?start=YYYY-MM-DD&end=YYYY-MM-DD
 * - POST /extranet/property/rooms/:id/inventory/bulk  {start,end,items:[{date,roomsOpen,minStay,isClosed}]}
 * - GET  /extranet/property/rooms/:id/prices?start=YYYY-MM-DD&end=YYYY-MM-DD
 * - POST /extranet/property/rooms/:id/prices/bulk     {start,end,items:[{date,price,ratePlanId}]}
 */

type Room = { id: number; name: string; occupancy: number; code: string | null; description: string | null };

const mem = {
  rooms: [] as Room[],
  inv: new Map<number, Map<string, { date: string; roomsOpen: number | null; minStay: number | null; isClosed: boolean }>>(),
  prices: new Map<number, Map<string, { date: string; ratePlanId: string | null; price: number }>>(),
};

function ensureInvMap(roomId: number) {
  if (!mem.inv.has(roomId)) mem.inv.set(roomId, new Map());
  return mem.inv.get(roomId)!;
}
function ensurePriceMap(roomId: number) {
  if (!mem.prices.has(roomId)) mem.prices.set(roomId, new Map());
  return mem.prices.get(roomId)!;
}

function parseDate(s: string) {
  // yyyy-mm-dd
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : d;
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
function iso(d: Date) {
  return d.toISOString().slice(0, 10);
}

/** Rooms list */
r.get("/", (_req, res) => {
  try {
    return res.status(200).json(mem.rooms);
  } catch (e) {
    console.error("[rooms:get] error", e);
    return res.status(500).json({ error: "Rooms list failed" });
  }
});

/** Create room */
r.post("/", (req, res) => {
  try {
    const { name, occupancy, code, description } = req.body ?? {};
    if (!name || typeof name !== "string") return res.status(400).json({ error: "name is required" });
    const id = Math.floor(Math.random() * 1_000_000);
    const room: Room = {
      id,
      name: name.trim(),
      occupancy: occupancy == null ? 2 : Number(occupancy),
      code: code ? String(code) : null,
      description: description ? String(description) : null,
    };
    mem.rooms.push(room);
    return res.status(201).json(room);
  } catch (e) {
    console.error("[rooms:post] error", e);
    return res.status(500).json({ error: "Create failed" });
  }
});

/** Inventory GET */
r.get("/:id/inventory", (req, res) => {
  try {
    const roomId = Number(req.params.id);
    const start = String(req.query.start || "");
    const end = String(req.query.end || "");
    const ds = parseDate(start);
    const de = parseDate(end);
    if (!roomId || !ds || !de) return res.status(400).json({ error: "bad params" });

    const m = ensureInvMap(roomId);
    const out: Array<{ date: string; roomsOpen: number | null; minStay: number | null; isClosed: boolean }> = [];
    // Return only saved entries within the range
    for (let d = ds; d <= de; d = addDays(d, 1)) {
      const key = iso(d);
      const rec = m.get(key);
      if (rec) out.push(rec);
    }
    return res.json(out);
  } catch (e) {
    console.error("[inventory:get] error", e);
    return res.status(500).json({ error: "Inventory fetch failed" });
  }
});

/** Inventory BULK POST */
r.post("/:id/inventory/bulk", (req, res) => {
  try {
    const roomId = Number(req.params.id);
    const { items } = req.body ?? {};
    if (!roomId || !Array.isArray(items)) return res.status(400).json({ error: "bad payload" });
    const m = ensureInvMap(roomId);
    let upserted = 0;
    for (const it of items) {
      if (!it?.date || !parseDate(it.date)) continue;
      const rec = {
        date: it.date,
        roomsOpen: it.roomsOpen == null ? null : Number(it.roomsOpen),
        minStay: it.minStay == null ? null : Number(it.minStay),
        isClosed: Boolean(it.isClosed),
      };
      m.set(it.date, rec);
      upserted++;
    }
    return res.json({ ok: true, upserted });
  } catch (e) {
    console.error("[inventory:bulk] error", e);
    return res.status(500).json({ error: "Inventory save failed" });
  }
});

/** Prices GET */
r.get("/:id/prices", (req, res) => {
  try {
    const roomId = Number(req.params.id);
    const start = String(req.query.start || "");
    const end = String(req.query.end || "");
    const ds = parseDate(start);
    const de = parseDate(end);
    if (!roomId || !ds || !de) return res.status(400).json({ error: "bad params" });

    const m = ensurePriceMap(roomId);
    const out: Array<{ date: string; ratePlanId: string | null; price: number }> = [];
    for (let d = ds; d <= de; d = addDays(d, 1)) {
      const key = iso(d) + "|base";
      const rec = m.get(key);
      if (rec) out.push(rec);
    }
    return res.json(out);
  } catch (e) {
    console.error("[prices:get] error", e);
    return res.status(500).json({ error: "Prices fetch failed" });
  }
});

/** Prices BULK POST */
r.post("/:id/prices/bulk", (req, res) => {
  try {
    const roomId = Number(req.params.id);
    const { items } = req.body ?? {};
    if (!roomId || !Array.isArray(items)) return res.status(400).json({ error: "bad payload" });
    const m = ensurePriceMap(roomId);
    let upserted = 0;
    for (const it of items) {
      if (!it?.date || !parseDate(it.date)) continue;
      const key = it.date + "|" + (it.ratePlanId ?? "base");
      const rec = { date: it.date, ratePlanId: it.ratePlanId ?? null, price: Number(it.price ?? 0) };
      m.set(key, rec);
      upserted++;
    }
    return res.json({ ok: true, upserted });
  } catch (e) {
    console.error("[prices:bulk] error", e);
    return res.status(500).json({ error: "Prices save failed" });
  }
});

// --- TEMP DEBUG: confirm instance + memory state ---
const BOOT_ID = Math.random().toString(36).slice(2, 9);
r.get("/__debug", (_req, res) => {
  res.json({
    ok: true,
    bootId: BOOT_ID,
    roomsCount: mem.rooms.length,
    rooms: mem.rooms,
    now: new Date().toISOString(),
  });
});

export default r;
