import { Router, type Request, type Response } from "express";

// ANCHOR: CATALOG_IMPORTS
import {
  getSearchList,
  getDetails,
  getCurrency,
  getProfilesFromDb,
  getRoomsDailyFromDb,
} from "../adapters/catalogSource.js";

const router = Router();

/**
 * GET /catalog/search
 * Query params:
 *  - start: YYYY-MM-DD
 *  - end:   YYYY-MM-DD (exclusive)
 *  - ratePlanId?: number
 */
router.get("/search", async (req: Request, res: Response) => {
  try {
    // ---- Extract params (strict) ------------------------------------------
    const start = String(req.query.start || "").trim();
    const end = String(req.query.end || "").trim();
    const ratePlanId = req.query.ratePlanId ? Number(req.query.ratePlanId) : undefined;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return res.status(400).json({ error: "start/end must be YYYY-MM-DD" });
    }

    const params = { start, end, ratePlanId };

    // ---- 1) Base list from mock adapter (stable layout, cards, etc.) ------
    const list = await getSearchList(params); // { properties: [...] }
    const props = Array.isArray(list?.properties) ? list.properties : [];
    if (props.length === 0) return res.json({ properties: [] });

    // ---- 2) Enrich: profiles/photos from DB -------------------------------
    const ids: number[] = [];
    for (const p of props) {
      const idNum = Number(p?.id);
      if (Number.isFinite(idNum)) ids.push(idNum);
    }
    if (ids.length > 0) {
      // ANCHOR: MERGE_DB_PROFILES_START
      try {
        const profMap = await getProfilesFromDb(ids);
        for (const p of props) {
          const pid = Number(p?.id);
          const prof = profMap[pid];
          if (!prof) continue;

          p.name = prof.name || p.name || "";
          p.city = prof.city || p.city || "";
          p.country = prof.country || p.country || "";
          if (Array.isArray(prof.images) && prof.images.length) {
            if (!p.images || !Array.isArray(p.images)) p.images = [];
            p.images = [...prof.images, ...p.images];
          }
        }
      } catch (err) {
        req.app?.get("logger")?.warn?.({ err }, "profiles-db-wire failed");
        // continue with mock-only profiles if DB blows up
      }
      // ANCHOR: MERGE_DB_PROFILES_END

      // ANCHOR: MERGE_DB_PROFILES_END
    }

    // ---- 3) Rooms/Inventory/Prices from DB (fallback to mock if empty) ----
    // ANCHOR: ROOMS_DB_WIRE_START
    for (const p of props) {
      const pid = Number(p?.id);
      if (!Number.isFinite(pid)) continue;

      try {
        const dbRooms = await getRoomsDailyFromDb(pid, params.start, params.end, params.ratePlanId);
        if (Array.isArray(dbRooms) && dbRooms.length > 0) {
          if (p.detail && Array.isArray(p.detail.rooms)) {
            p.detail.rooms = dbRooms;
          } else if (p.detail) {
            p.detail.rooms = dbRooms;
          } else {
            p.detail = { rooms: dbRooms };
          }
        }
      } catch (err) {
        req.app?.get("logger")?.warn?.({ err, propertyId: pid }, "rooms-db-wire failed");
      }
    }
    // ANCHOR: ROOMS_DB_WIRE_END

    // ---- 4) Currency backfill (ensure each daily row has currency) --------
    // ANCHOR: CURRENCY_BACKFILL_START
    try {
      const cur = await getCurrency();
      for (const p of props) {
        const rooms = p?.detail?.rooms;
        if (!Array.isArray(rooms)) continue;
        for (const r of rooms) {
          const daily = r?.daily;
          if (!Array.isArray(daily)) continue;
          for (const d of daily) if (!d.currency) d.currency = cur;
        }
      }
    } catch (err) {
      req.app?.get("logger")?.warn?.({ err }, "currency-backfill failed");
      // continue without currency if adapter import fails
    }
    // ANCHOR: CURRENCY_BACKFILL_END

    return res.json({ properties: props });
  } catch (err: any) {
    req.app?.get("logger")?.error?.({ err }, "catalog.search failed");
    return res.status(500).json({ error: "Internal error" });
  }
});

/**
 * GET /catalog/details
 * Query params:
 *  - propertyId: number (maps to Partner.id)
 *  - start: YYYY-MM-DD
 *  - end:   YYYY-MM-DD (exclusive)
 *  - ratePlanId?: number
 */
router.get("/details", async (req: Request, res: Response) => {
  try {
    const propertyId = Number(req.query.propertyId ?? req.query.id);
    const start = String(req.query.start || "").trim();
    const end = String(req.query.end || "").trim();
    const ratePlanId = req.query.ratePlanId
      ? Number(req.query.ratePlanId)
      : (req.query.plan ? Number(req.query.plan) : undefined);

    if (!Number.isFinite(propertyId)) {
      return res.status(400).json({ error: "propertyId must be a number" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return res.status(400).json({ error: "start/end must be YYYY-MM-DD" });
    }

    // Base (mock) details
    const base = await getDetails({ propertyId, start, end, ratePlanId });

    // Optional: enrich rooms with DB daily (fallback to mock already present)
    try {
      const dbRooms = await getRoomsDailyFromDb(propertyId, start, end, ratePlanId);
      if (Array.isArray(dbRooms) && dbRooms.length > 0) {
        if (base?.rooms && Array.isArray(base.rooms)) {
          base.rooms = dbRooms;
        } else if (base) {
          base.rooms = dbRooms;
        }
      }
    } catch (err) {
      req.app?.get("logger")?.warn?.({ err, propertyId }, "details.rooms-db-wire failed");
    }

    // Currency backfill
    const cur = await getCurrency();
    if (base?.rooms && Array.isArray(base.rooms)) {
      for (const r of base.rooms) {
        if (!Array.isArray(r?.daily)) continue;
        for (const d of r.daily) if (!d.currency) d.currency = cur;
      }
    }

    return res.json(base ?? {});
  } catch (err: any) {
    req.app?.get("logger")?.error?.({ err }, "catalog.details failed");
    return res.status(500).json({ error: "Internal error" });
  }
});

export default router;
