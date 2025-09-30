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
 *  - start: YYYY-MM-DD  (required)
 *  - end:   YYYY-MM-DD  (required, exclusive)
 *  - ratePlanId?: number
 *  - guests?: number     (default 2)  ← used for availability ≥ guests
 *  - city?: string       (cityCode preferred; falls back to city text)
 *  - db?: "0" | "1"      ("0" = mock only; "1" = try DB then mock)
 */
router.get("/search", async (req: Request, res: Response) => {
  req.app?.get("logger")?.info?.({ q: req.query }, "catalog.search invoked");
  console.log("[catalog] search invoked", req.query);

  try {
    // ---- Response caching ----
    res.set("Cache-Control", "no-store");

    // ---- Extract params (strict) ------------------------------------------
    const start = String(req.query.start || "").trim();
    const end = String(req.query.end || "").trim();
    const ratePlanId = req.query.ratePlanId ? Number(req.query.ratePlanId) : undefined;
    const guests = Math.max(1, Number(req.query.guests ?? 2));
    const citySelRaw = String(req.query.city ?? "").trim();
    const citySel = citySelRaw ? citySelRaw.toUpperCase() : ""; // compare against cityCode or city↑
    const wantsDb = (req.query.db ?? "1") !== "0"; // ANCHOR: NONBLOCK_ENRICH

    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return res.status(400).json({ error: "start/end must be YYYY-MM-DD" });
    }

    const params = { start, end, ratePlanId };

    // ---- 1) Base list (DB-first, fallback to mock) ------------------------
    let list: any; let _baseSource: "db" | "mock" = "mock";
    if (wantsDb) {
      try {
        list = await getSearchListFromDb(params);
        _baseSource = "db";
      } catch {
        list = await getSearchList(params);
        _baseSource = "mock";
      }
    } else {
      list = await getSearchList(params);
      _baseSource = "mock";
    }

    const props: any[] = Array.isArray(list?.properties) ? list.properties : [];
    for (const p of props) { try { (p as any)._baseSource = _baseSource; } catch {} }
    if (props.length === 0) return res.json({ properties: [] });

    // ANCHOR: NORMALIZE_ID_START
    for (const p of props) {
      if (p && p.id == null && p.propertyId != null) p.id = p.propertyId;
    }
    // ANCHOR: STRIP_LEGACY_ID
    for (const p of props) { try { delete (p as any).id; } catch {} }

    // ---- Early return path when db=0 (but kick off async enrichment) ------
    if (!wantsDb) {
      setTimeout(() => {
        (async () => {
          try {
            const idsBg: number[] = [];
            for (const p of props) {
              const idNum = Number(p?.propertyId);
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

      // Client may apply city/guests filters; return base props now
      return res.json({ properties: props });
    }

    // ---- 2) Enrich: profiles/photos from DB -------------------------------
    const ids: number[] = [];
    for (const p of props) {
      const idNum = Number(p?.propertyId);
      if (Number.isFinite(idNum)) ids.push(idNum);
    }

    if (ids.length > 0) {
      // ANCHOR: MERGE_DB_PROFILES_START
      try {
        const profMap = await getProfilesFromDb(ids);
        for (const p of props) {
          const pid = Number(p?.propertyId);
          const prof = profMap[pid];
          if (!prof) continue;

          // Identity/location (prefer DB)
          p.name = prof.name ?? p.name ?? "";
          p.city = prof.city ?? p.city ?? "";
          p.country = prof.country ?? p.country ?? "";

          // cityCode normalization if provided by DB (typed via any to avoid TS mismatch)
          const profCityCode = (prof as any)?.cityCode;
          if (typeof profCityCode === "string" && profCityCode.trim()) {
            (p as any).cityCode = profCityCode.toUpperCase();
          }

          // Images: prefer DB when available
          if (Array.isArray(prof.images) && prof.images.length) {
            p.images = prof.images;
          }
        }
      } catch (err) {
        req.app?.get("logger")?.warn?.({ err }, "profiles-db-wire failed");
      }
      // ANCHOR: MERGE_DB_PROFILES_END
    }

    // ---- 3) Rooms/Inventory/Prices from DB (with timebox) -----------------
    // Count only nights with inventory >= guests AND not closed
    const TIMEBOX_MS = Math.max(500, Number(process.env.CATALOG_ROOMS_TIMEBOX_MS ?? 2500));
    const timebox = <T>(promise: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race([promise, new Promise<T | null>(resolve => setTimeout(() => resolve(null), ms))]);

    let roomsApplied = 0;

    for (const p of props) {
      const pid = Number(p?.propertyId);
      if (!Number.isFinite(pid)) continue;

      try {
        const rooms: RoomsDailyRow[] = (await timebox<RoomsDailyRow[]>(
          getRoomsDailyFromDb(pid, params.start, params.end, params.ratePlanId),
          TIMEBOX_MS
        )) ?? [];

        if (rooms.length > 0) {
          // attach rooms to detail
          if (p.detail && Array.isArray(p.detail.rooms)) {
            p.detail.rooms = rooms;
          } else if (p.detail) {
            p.detail.rooms = rooms;
          } else {
            p.detail = { rooms };
          }
          roomsApplied++;
          try { (p.detail as any)._roomsSource = "db"; } catch {}

          // Rollup (availability & fromPrice) with guests threshold
          type Daily = RoomsDailyRow["daily"][number];
          const allDaily: Daily[] = rooms.flatMap((r) => (r.daily as Daily[]) || []);
          const availNights = allDaily.filter((d: Daily) =>
            !d.closed && Number(d?.inventory ?? d?.open ?? 0) >= guests
          ).length;
          const priced: Daily[] = allDaily.filter((d: Daily) => typeof d?.price === "number");
          const minPrice = priced.length ? Math.min(...priced.map((d: Daily) => Number(d!.price))) : null;
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
              (p as any).fromPriceStr = `$${Number(minPrice).toFixed(2)}`;
            }
          }
        }
      } catch (err) {
        req.app?.get("logger")?.warn?.({ err, propertyId: pid }, "rooms-db-wire failed");
      }
    }

    // ---- 4) Currency backfill (ensure each daily row has currency) --------
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

    // ---- 5) City filter (server-side) -------------------------------------
    let out = props;
    if (citySel) {
      const norm = (s: string) => (s || "").trim().toUpperCase();

      // Alias map: accept common city names that map to our city codes
      const CITY_ALIASES: Record<string, string[]> = {
        SIARGAO: ["SIARGAO", "GENERAL LUNA", "GEN LUNA"],
        BORACAY: ["BORACAY", "MALAY"],
        ELNIDO:  ["EL NIDO", "ELNIDO"],
        CEBU:    ["CEBU", "LAPU-LAPU", "MACTAN"],
        MANILA:  ["MANILA", "MAKATI", "TAGUIG", "BGC"],
      };

      const wanted = (CITY_ALIASES[citySel] ?? [citySel]).map(norm);

      out = props.filter(p => {
        const code = norm((p as any).cityCode || "");
        const city = norm(p.city || "");
        // pass if any alias matches cityCode OR city text
        return wanted.includes(code) || wanted.includes(city);
      });
    }


    // ---- 6) Filter out properties with 0 available nights -----------------
    out = out.filter(p => Number(p?.availableNights ?? 0) > 0);

    // ---- Final -------------------------------------------------------------
    return res.json({ properties: out, _dbg: { wantsDb, roomsApplied, guests, citySel: citySel || undefined } });

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
    if (!base || typeof base !== "object") { base = {}; }
    console.log("[details] start", { propertyId, start, end, ratePlanId });

    // Profile/Photos (prefer DB)
    try {
      const profMap = await getProfilesFromDb([propertyId]);
      const prof = profMap?.[propertyId];
      if (prof) {
        base.name    = prof.name    || base.name    || "";
        base.city    = prof.city    || base.city    || "";
        base.country = prof.country || base.country || "";
        if (Array.isArray(prof.images) && prof.images.length) {
          base.images = [...prof.images, ...(Array.isArray(base.images) ? base.images : [])];
        }
      }
    } catch (err) {
      req.app?.get("logger")?.warn?.({ err, propertyId }, "details.profiles-db-wire failed");
    }

    // Ensure meta/property carries identity + images
    try {
      const profMap = await getProfilesFromDb([propertyId]);
      const prof = profMap?.[propertyId];
      if (prof) {
        (base as any).meta ||= {};
        (base as any).meta.property ||= {};
        (base as any).meta.property.name    = prof.name    ?? (base as any).meta.property.name    ?? base.name    ?? "";
        (base as any).meta.property.city    = prof.city    ?? (base as any).meta.property.city    ?? base.city    ?? "";
        (base as any).meta.property.country = prof.country ?? (base as any).meta.property.country ?? base.country ?? "";

        if (Array.isArray(prof.images) && prof.images.length) {
          (base as any).meta.property.images = prof.images;
          if (Array.isArray((base as any).rooms) && (base as any).rooms[0]) {
            const r0 = (base as any).rooms[0];
            if (!Array.isArray(r0.images) || r0.images.length === 0) {
              r0.images = prof.images;
            }
          } else {
            (base as any).rooms = [{ images: prof.images, daily: [] }];
          }
        }
      }
    } catch (err) {
      req.app?.get("logger")?.warn?.({ err, propertyId }, "details.profile-db-wire failed");
    }

    // Optional: overlay DB daily rooms
    try {
      const dbRooms = await getRoomsDailyFromDb(propertyId, start, end, ratePlanId);
      if (Array.isArray(dbRooms) && dbRooms.length > 0) {
        if (Array.isArray(base.rooms)) {
          base.rooms = dbRooms;
        } else {
          (base as any).rooms = dbRooms;
        }
        (base as any)._roomsSource = "db";
      }
    } catch (err) {
      req.app?.get("logger")?.warn?.({ err, propertyId }, "details.rooms-db-wire failed");
    }

    // Currency backfill
    try {
      const cur = await getCurrency();
      if (Array.isArray(base?.rooms)) {
        for (const r of base.rooms as RoomsDailyRow[]) {
          const daily = r?.daily as RoomsDailyRow["daily"];
          if (!Array.isArray(daily)) continue;
          for (const d of daily) if (!d.currency) d.currency = cur;
        }
      }
    } catch (err) {
      req.app?.get("logger")?.warn?.({ err }, "details.currency-backfill failed");
    }

    // Rollup
    try {
      if (Array.isArray(base?.rooms)) {
        type Daily = RoomsDailyRow["daily"][number];
        const allDaily: Daily[] = (base.rooms as RoomsDailyRow[]).flatMap(
          (r: RoomsDailyRow) => (r.daily as Daily[]) || []
        );

        const availNights = allDaily.filter((d: Daily) => (d?.inventory ?? 0) > 0 && !d.closed).length;
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

    console.log("[details] final", {
      propertyId,
      hasImages: Array.isArray(base?.images) && base.images.length > 0,
      roomsCount: Array.isArray(base?.rooms) ? base.rooms.length : 0,
      availableNights: (base as any)?.availableNights ?? null,
      nightsTotal: (base as any)?.nightsTotal ?? null,
      fromPriceStr: (base as any)?.fromPriceStr ?? null,
      roomsSource: (base as any)?._roomsSource ?? null
    });
    return res.json(base ?? {});
  } catch (err: any) {
    req.app?.get("logger")?.error?.({ err }, "catalog.details failed");
    return res.status(500).json({ error: "Internal error" });
  }
});

export default router;
