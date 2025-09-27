import { Router, type Request, type Response } from "express";

// ANCHOR: CATALOG_IMPORTS
import {
  getSearchList,
  getSearchListFromDb,
  getDetails,
  getCurrency,
  getProfilesFromDb,
  getRoomsDailyFromDb,
} from "../adapters/catalogSource.js";
import type { RoomsDailyRow } from "../adapters/catalogSource.js";

const router = Router();

/**
 * GET /catalog/search
 * Query params:
 *  - start: YYYY-MM-DD
 *  - end:   YYYY-MM-DD (exclusive)
 *  - ratePlanId?: number
 */
router.get("/search", async (req: Request, res: Response) => {
    req.app?.get("logger")?.info?.({ q: req.query }, "catalog.search invoked");
    console.log("[catalog] search invoked", req.query);

  try {
    // ANCHOR: NO_STORE_HEADER
    res.set("Cache-Control", "no-store");

    // ---- Extract params (strict) ------------------------------------------
    const start = String(req.query.start || "").trim();
    const end = String(req.query.end || "").trim();
    const ratePlanId = req.query.ratePlanId ? Number(req.query.ratePlanId) : undefined;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return res.status(400).json({ error: "start/end must be YYYY-MM-DD" });
    }

    const params = { start, end, ratePlanId };

    // ---- 1) Base list from mock adapter (stable layout, cards, etc.) ------
    const wantsDb = (req.query.db ?? "1") !== "0"; // ANCHOR: NONBLOCK_ENRICH
    let list; let _baseSource: "db" | "mock" = "mock";
    if (wantsDb) {
      try {
        list = await getSearchListFromDb(params); // DB-first
        _baseSource = "db";
      } catch {
        list = await getSearchList(params);       // fallback to mock
        _baseSource = "mock";
      }
    } else {
      list = await getSearchList(params);         // mock when db=0
      _baseSource = "mock";
    }
    // { properties: [...] }

    const props: any[] = Array.isArray(list?.properties) ? list.properties : [];
    for (const p of props) { try { (p as any)._baseSource = _baseSource; } catch {} }
    if (props.length === 0) return res.json({ properties: [] });

    // ANCHOR: NORMALIZE_ID_START
    for (const p of props) {
      if (p && p.id == null && p.propertyId != null) p.id = p.propertyId;
    }
    // ANCHOR: STRIP_LEGACY_ID
    for (const p of props) { try { delete (p as any).id; } catch {} }

    if (!wantsDb) {
      // run enrichment in the background and return immediately
      setTimeout(() => {
        (async () => {
          try {
            const idsBg: number[] = [];
            for (const p of props) {
              const idNum = Number(p?.id ?? p?.propertyId);
              if (Number.isFinite(idNum)) idsBg.push(idNum);
            }

            const timebox = <T>(promise: Promise<T>, ms: number): Promise<T | null> =>
              Promise.race([promise, new Promise<T | null>(resolve => setTimeout(() => resolve(null), ms))]);

            await timebox(getProfilesFromDb(idsBg), 800);

            const startISO = params.start, endISO = params.end, planId = params.ratePlanId;
            for (const pid of idsBg) {
              await timebox(getRoomsDailyFromDb(pid, startISO, endISO, planId), 250);
            }
          } catch (e) {
            req.app?.get("logger")?.warn?.({ e }, "bg.enrich failed");
          }
        })().catch(() => {});
      }, 0);

      return res.set("Cache-Control", "no-store").json({ properties: props });
    }
    // else: wantsDb === true → skip early return and continue to the DB enrichment
    let _roomsApplied = 0; // debug: count properties where DB rooms were applied

    // ---- 2) Enrich: profiles/photos from DB -------------------------------
    const ids: number[] = [];
    for (const p of props) {
      const idNum = Number(p?.id ?? p?.propertyId);
      if (Number.isFinite(idNum)) ids.push(idNum);
    }

    if (ids.length > 0) {
      // ANCHOR: MERGE_DB_PROFILES_START
      try {
        const profMap = await getProfilesFromDb(ids);
        for (const p of props) {
          const pid = Number(p?.id ?? p?.propertyId);
          const prof = profMap[pid];
          if (!prof) continue;

          p.name = prof.name ?? "";
          p.city = prof.city ?? "";
          p.country = prof.country ?? "";

          if (Array.isArray(prof.images) && prof.images.length) {
            if (!p.images || !Array.isArray(p.images)) p.images = [];
            p.images = prof.images; // prefer DB images only
          }
        }
      } catch (err) {
        req.app?.get("logger")?.warn?.({ err }, "profiles-db-wire failed");
      }
      // ANCHOR: MERGE_DB_PROFILES_END
    }

    // ---- 3) Rooms/Inventory/Prices from DB (fallback to mock if empty) ----
    // ANCHOR: ROOMS_DB_WIRE_START
const TIMEBOX_MS = Math.max(500, Number(process.env.CATALOG_ROOMS_TIMEBOX_MS ?? 2500));
    // timebox helper so foreground DB enrichment can’t hang the request
    const timebox = <T>(promise: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race([promise, new Promise<T | null>(resolve => setTimeout(() => resolve(null), ms))]);

    for (const p of props) {
      const pid = Number(p?.id ?? p?.propertyId);
      if (!Number.isFinite(pid)) continue;

      try {
        // cap each property’s DB fetch to ~2500ms (cold-start safe)
        const rooms: RoomsDailyRow[] = (await timebox<RoomsDailyRow[]>(
          getRoomsDailyFromDb(pid, params.start, params.end, params.ratePlanId),
          2500
        )) ?? [];

        if (rooms.length > 0) {

          // overlay rooms
          if (p.detail && Array.isArray(p.detail.rooms)) {
            p.detail.rooms = rooms;
          } else if (p.detail) {
            p.detail.rooms = rooms;
          } else {
            p.detail = { rooms };
          }
          _roomsApplied++; // <— increment here (after rooms are applied)

          // ANCHOR: ROOMS_DB_SOURCE_FLAG
          try { (p.detail as any)._roomsSource = "db"; } catch {}

          // ANCHOR: ROOMS_DB_ROLLUP_FROM_DB (unchanged logic, typed)
          try {
            type Daily = RoomsDailyRow["daily"][number];
            const allDaily: Daily[] = rooms.flatMap(
              (r: RoomsDailyRow) => (r.daily as Daily[]) || []
            );
            const availNights = allDaily.filter((d: Daily) => (d.inventory ?? 0) > 0).length;
            const priced: Daily[] = allDaily.filter((d: Daily) => typeof d.price === "number");
            const minPrice = priced.length ? Math.min(...priced.map((d: Daily) => (d.price as number))) : null;
            const curCode = (priced[0]?.currency as string) || "USD";

            (p as any).availableNights = availNights;
            (p as any).nightsTotal = allDaily.length;

            if (minPrice != null && Number.isFinite(minPrice)) {
              (p as any).fromPrice = minPrice;
              try {
                (p as any).fromPriceStr = new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency: curCode,
                }).format(Number(minPrice));
              } catch {
                (p as any).fromPriceStr = `$${(minPrice as number).toFixed(2)}`;
              }
            }
          } catch (e) {
            req.app?.get("logger")?.warn?.({ e, propertyId: pid }, "rooms-db-rollup failed");
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
        for (const r of rooms as RoomsDailyRow[]) {
          const daily = r?.daily as RoomsDailyRow["daily"];
          if (!Array.isArray(daily)) continue;
          for (const d of daily) if (!d.currency) d.currency = cur;
        }
      }
    } catch (err) {
      req.app?.get("logger")?.warn?.({ err }, "currency-backfill failed");
    }
    // ANCHOR: CURRENCY_BACKFILL_END
    // ---- Final: respond with enriched list ----------------------------
    return res
      .set("Cache-Control", "no-store")
      .json({ properties: props, _dbg: { wantsDb, roomsApplied: _roomsApplied } });

    } catch (err: any) {
      const msg = err?.message || String(err);
      const stack = err?.stack || null;
      req.app?.get("logger")?.error?.({ err }, "catalog.search failed");
      return res.status(500).json({ error: "Internal error", _where: "catalog.search", _debug: msg, _stack: stack });
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
    res.set("Cache-Control", "no-store");
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
    let base: any = await getDetails({ propertyId, start, end, ratePlanId });
    // ANCHOR: DETAILS_BASE_GUARD
    if (!base || typeof base !== "object") { base = {}; }
    // ANCHOR: DETAILS_DBG_PROFILES_BEFORE
    console.log("[details] start", { propertyId, start, end, ratePlanId });

    // ANCHOR: DETAILS_DB_PROFILES
    try {
      const profMap = await getProfilesFromDb([propertyId]);
      console.log("[details] profiles-keys", { propertyId, keys: Object.keys(profMap || {}) });
      const prof = profMap?.[propertyId];
      if (prof) {
        base.name    = prof.name    || base.name    || "";
        base.city    = prof.city    || base.city    || "";
        base.country = prof.country || base.country || "";
        if (Array.isArray(prof.images) && prof.images.length) {
          const imgs = Array.isArray(base.images) ? base.images : [];
          base.images = [...prof.images, ...imgs];
          console.log("[details] profiles", { propertyId, name: base?.name ?? null, city: base?.city ?? null, images: Array.isArray(base?.images) ? base.images.length : 0 });
        }
      }
    } catch (err) {
      req.app?.get("logger")?.warn?.({ err, propertyId }, "details.profiles-db-wire failed");
    }
    // ANCHOR: DETAILS_DB_PROFILES_END

    // ANCHOR: DETAILS_DB_PROFILE_ENRICH
    try {
      const profMap = await getProfilesFromDb([propertyId]);
      const prof = profMap[propertyId];
      if (prof) {
        if (prof.name)    base.name    = prof.name;
        if (prof.city)    base.city    = prof.city;
        if (prof.country) base.country = prof.country;
        if (Array.isArray(prof.images) && prof.images.length) {
          base.images = [...prof.images]; // prefer DB images only
        }
      }
    } catch (err) {
      req.app?.get("logger")?.warn?.({ err, propertyId }, "details.profile-db-wire failed");
    }
    // ANCHOR: DETAILS_DB_PROFILE_ENRICH

    // Optional: enrich rooms with DB daily (fallback to mock already present)
    try {
      const dbRooms = await getRoomsDailyFromDb(propertyId, start, end, ratePlanId);
      console.log("[details] rooms-db", { propertyId, count: Array.isArray(dbRooms) ? dbRooms.length : 0 });

      if (Array.isArray(dbRooms) && dbRooms.length > 0) {
        if (base?.rooms && Array.isArray(base.rooms)) {
          base.rooms = dbRooms;
        } else if (base) {
          base.rooms = dbRooms;
        }
        (base as any)._roomsSource = "db"; // optional debug flag
      }
    } catch (err) {
      req.app?.get("logger")?.warn?.({ err, propertyId }, "details.rooms-db-wire failed");
    }

    // Currency backfill
    try {
      const cur = await getCurrency();
      if (base?.rooms && Array.isArray(base.rooms)) {
        for (const r of base.rooms as RoomsDailyRow[]) {
          const daily = r?.daily as RoomsDailyRow["daily"];
          if (!Array.isArray(daily)) continue;
          for (const d of daily) if (!d.currency) d.currency = cur;
        }
      }
    } catch (err) {
      req.app?.get("logger")?.warn?.({ err }, "details.currency-backfill failed");
    }
    // ANCHOR: DETAILS_ROLLUP_FROM_DB
    try {
      if (base?.rooms && Array.isArray(base.rooms)) {
        type Daily = RoomsDailyRow["daily"][number];
        const allDaily: Daily[] = (base.rooms as RoomsDailyRow[]).flatMap(
          (r: RoomsDailyRow) => (r.daily as Daily[]) || []
        );

        const availNights = allDaily.filter((d: Daily) => (d?.inventory ?? 0) > 0).length;
        const priced: Daily[] = allDaily.filter((d: Daily) => typeof d?.price === "number");
        const minPrice = priced.length ? Math.min(...priced.map((d: Daily) => Number(d!.price))) : null;
        const curCode = (priced[0]?.currency as string) || "USD";

        (base as any).availableNights = availNights;
        (base as any).nightsTotal = allDaily.length;

        if (minPrice != null && Number.isFinite(minPrice)) {
          (base as any).fromPrice = minPrice;
          try {
            (base as any).fromPriceStr = new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: curCode,
            }).format(Number(minPrice));
          } catch {
            (base as any).fromPriceStr = `$${Number(minPrice).toFixed(2)}`;
          }
        }
      }
    } catch (e) {
      req.app?.get("logger")?.warn?.({ e, propertyId }, "details.rollup failed");
    }
    // ANCHOR: DETAILS_ROLLUP_FROM_DB

    console.log("[details] final", { propertyId, hasImages: Array.isArray(base?.images) && base.images.length > 0, roomsCount: Array.isArray(base?.rooms) ? base.rooms.length : 0, availableNights: base?.availableNights ?? null, nightsTotal: base?.nightsTotal ?? null, fromPriceStr: base?.fromPriceStr ?? null, roomsSource: (base as any)?._roomsSource ?? null });
    return res.json(base ?? {});
  } catch (err: any) {
    req.app?.get("logger")?.error?.({ err }, "catalog.details failed");
    return res.status(500).json({ error: "Internal error" });
  }
});

export default router;

