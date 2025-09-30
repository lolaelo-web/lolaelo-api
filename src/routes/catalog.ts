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
import { Client as PgClient } from "pg";

const router = Router();

/**
 * GET /catalog/search
 * Query params:
 *  - start: YYYY-MM-DD
 *  - end:   YYYY-MM-DD (exclusive)
 *  - ratePlanId?: number
 *  - city?: string (e.g., SIARGAO). Matched against cityCode OR city (case-insensitive).
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
    const cityParam = String(req.query.city || "").trim().toUpperCase();

    // ---- 1) Base list from adapter (DB-first, mock fallback) --------------
    const wantsDb = (req.query.db ?? "1") !== "0"; // ANCHOR: NONBLOCK_ENRICH
    let list: any; let _baseSource: "db" | "mock" = "mock";
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

    // ---- Remap PropertyProfile.id -> Partner.id for adapters ----
    // Some rows arrive with propertyId = PropertyProfile.id (e.g. 42 for "mike check 1"),
    // but our adapters expect Partner.id (e.g. 55). Translate where possible.
    try {
      const { Client } = await import("pg");
      const cs = process.env.DATABASE_URL || "";
      if (cs) {
        const wantsSSL = /\bsslmode=require\b/i.test(cs) || /render\.com/i.test(cs);
        const db = new Client({
          connectionString: cs,
          ssl: wantsSSL ? { rejectUnauthorized: false } : undefined,
        });
        await db.connect();

        // collect unique propertyIds from the current list
        const profileIds: number[] = [];
        for (const p of props) {
          const pid = Number((p as any)?.propertyId);
          if (Number.isFinite(pid)) profileIds.push(pid);
        }
        const uniq = Array.from(new Set(profileIds)).slice(0, 200);

        if (uniq.length) {
          const q = `
            WITH ids AS (SELECT unnest($1::bigint[]) AS id)
            SELECT 'public'   AS schema, pp.id AS profile_id, pp."partnerId" AS partner_id
              FROM public."PropertyProfile" pp JOIN ids ON ids.id = pp.id
            UNION ALL
            SELECT 'extranet', pp.id AS profile_id, pp."partnerId" AS partner_id
              FROM extranet."PropertyProfile" pp JOIN ids ON ids.id = pp.id
          `;
          const { rows } = await db.query(q, [uniq]);

          // prefer extranet over public if both exist
          const profToPartner = new Map<number, number>();
          for (const r of rows) {
            const profId = Number(r.profile_id);
            const partnerId = Number(r.partner_id);
            if (!profToPartner.has(profId) || String(r.schema) === "extranet") {
              profToPartner.set(profId, partnerId);
            }
          }

          // apply remap in-place
          for (const p of props) {
            const profId = Number((p as any)?.propertyId);
            const partnerId = profToPartner.get(profId);
            if (Number.isFinite(partnerId)) {
              (p as any)._idRemap = { from: profId, to: partnerId }; // debug
              (p as any).propertyId = partnerId; // <-- switch to Partner.id
            }
          }

          // helpful debug in server logs
          try {
            const remaps = props
              .map((p: any) => p?._idRemap)
              .filter(Boolean);
            if (remaps.length) {
              console.log("[catalog.search][remap] profile→partner", remaps);
            } else {
              console.log("[catalog.search][remap] no remaps applied");
            }
          } catch {}
        }

        await db.end();
      } else {
        console.warn("[catalog.search][remap] DATABASE_URL missing; skipped");
      }
    } catch (e) {
      req.app?.get("logger")?.warn?.({ e }, "profile->partner remap skipped");
    }


    // NOTE: DO NOT city-filter here. We wait until after DB profile enrichment,
    // because profiles populate city/cityCode.

    if (!wantsDb) {
      // run enrichment in the background and return immediately
      setTimeout(() => {
        (async () => {
          try {
            const idsBg: number[] = [];
            for (const p of props) {
              const idNum = Number((p as any)?.propertyId);
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

    let _roomsApplied = 0; // debug: count properties where DB rooms were applied

    // ---- 2) Enrich: profiles/photos from DB -------------------------------
    const ids: number[] = [];
    for (const p of props) {
      const idNum = Number((p as any)?.propertyId);
      if (Number.isFinite(idNum)) ids.push(idNum);
    }

    if (ids.length > 0) {
      // ANCHOR: MERGE_DB_PROFILES_START
      try {
        const profMap = await getProfilesFromDb(ids);
        console.log("[catalog.search] ids for profMap:", ids);
        console.log("[catalog.search] profMap keys:", Object.keys(profMap || {}));
        for (const p of props) {
          const pid = Number((p as any)?.propertyId);
          const prof = profMap[pid];
          if (!prof) continue;

          // prefer DB identity/location labels
          (p as any).name    = prof.name ?? (p as any).name ?? "";
          (p as any).city    = prof.city ?? (p as any).city ?? "";
          (p as any).country = prof.country ?? (p as any).country ?? "";

          // optional: normalize cityCode if provided by DB profile
          const _cityCode = (prof as any)?.cityCode as unknown;
          if (typeof _cityCode === "string" && _cityCode.length) {
            (p as any).cityCode = _cityCode.toUpperCase();
          }

          if (Array.isArray(prof.images) && prof.images.length) {
            if (!(p as any).images || !Array.isArray((p as any).images)) (p as any).images = [];
            (p as any).images = prof.images; // prefer DB images only
          }
        }
      } catch (err) {
        req.app?.get("logger")?.warn?.({ err }, "profiles-db-wire failed");
      }
      // ANCHOR: MERGE_DB_PROFILES_END
      }
          // ---- Remap profile id → partner id (so rooms lookup hits the right key) ----
      try {
        const idsToRemap = props
          .map((p) => Number((p as any).propertyId))
          .filter((n) => Number.isFinite(n)) as number[];

        if (idsToRemap.length) {
          const cs = process.env.DATABASE_URL || "";
          const wantsSSL = /\bsslmode=require\b/i.test(cs) || /render\.com/i.test(cs);
          const pg = new PgClient({
            connectionString: cs,
            ssl: wantsSSL ? { rejectUnauthorized: false } : undefined,
          });
          await pg.connect();

          const { rows } = await pg.query(
            `
            SELECT id AS profile_id, "partnerId" AS partner_id
            FROM public."PropertyProfile"
            WHERE id = ANY($1::int[])
            UNION ALL
            SELECT id AS profile_id, "partnerId" AS partner_id
            FROM extranet."PropertyProfile"
            WHERE id = ANY($1::int[])
          `,
            [idsToRemap]
          );

          const map = new Map<number, number>();
          for (const r of rows) {
            const from = Number(r.profile_id);
            const to = Number(r.partner_id);
            if (Number.isFinite(from) && Number.isFinite(to)) map.set(from, to);
          }

          const changes: Array<{ from: number; to: number }> = [];
          for (const p of props) {
            const from = Number((p as any).propertyId);
            const to = map.get(from);
            if (to && to !== from) {
              (p as any).propertyId = to; // rewrite to Partner.id
              changes.push({ from, to });
            }
          }

          console.log("[catalog.search][remap] profile→partner", changes);
          await pg.end();
        }
      } catch (e) {
        req.app?.get("logger")?.warn?.({ e }, "remap profileId→partnerId failed");
      }

    // ---- 2b) NOW apply server-side CITY FILTER (after enrichment) ----------
    const beforeCity = props.length;
    if (cityParam) {
      for (let i = props.length - 1; i >= 0; i--) {
        const cc = String((props[i] as any)?.cityCode || "").toUpperCase();
        const c  = String((props[i] as any)?.city     || "").toUpperCase();
        if (cc !== cityParam && c !== cityParam) props.splice(i, 1);
      }
    }
    const afterCity = props.length;
    // If nothing left after enrichment/city filter, try a DB fallback:
    // Find partners that actually have open inventory AND prices for the date range
    // (and ratePlanId if provided). Then seed minimal cards for enrichment.
    if (props.length === 0) {
      try {
        const cs = process.env.DATABASE_URL || "";
        if (cs) {
          const wantsSSL = /\bsslmode=require\b/i.test(cs) || /render\.com/i.test(cs);
          const pg = new PgClient({
            connectionString: cs,
            ssl: wantsSSL ? { rejectUnauthorized: false } : undefined,
          });
          await pg.connect();

          const q = `
            WITH dd AS (
              SELECT generate_series($1::date, ($2::date - INTERVAL '1 day'), INTERVAL '1 day')::date AS d
            ),
            inv AS (
              SELECT DISTINCT ri."partnerId" AS pid
              FROM extranet."RoomInventory" ri
              JOIN dd ON dd.d = ri.date
              WHERE COALESCE(ri."roomsOpen", 0) > 0 AND COALESCE(ri."isClosed", FALSE) = FALSE
            ),
            price AS (
              SELECT DISTINCT rp."partnerId" AS pid
              FROM extranet."RoomPrice" rp
              JOIN dd ON dd.d = rp.date
              WHERE ($3::int IS NULL OR rp."ratePlanId" = $3::int)
            ),
            cand AS (
              SELECT DISTINCT i.pid
              FROM inv i
              JOIN price p ON p.pid = i.pid
            )
            SELECT
              COALESCE(pp.id, p.id)                AS "propertyId",
              COALESCE(pp.name, p.name, '')        AS name,
              COALESCE(pp.city, '')                AS city,
              ''                                   AS country
            FROM cand c
            JOIN extranet."Partner" p           ON p.id = c.pid
            LEFT JOIN extranet."PropertyProfile" pp ON pp."partnerId" = p.id
          `;

          const { rows } = await pg.query(q, [start, end, ratePlanId ?? null]);
          await pg.end();

          // Seed minimal cards so normal enrichment (photos, roomsDaily) can run
          for (const r of rows) {
            // Respect ?city= if provided (match either cityCode we may add later or city label now)
            if (cityParam) {
              const c = String(r.city || "").toUpperCase();
              if (c !== cityParam) continue;
            }

            props.push({
              propertyId: Number(r.propertyId),
              name: r.name || "",
              city: r.city || "",
              country: r.country || "",
              images: [],
              detail: { rooms: [] },
              _baseSource: "db-fallback",
            });
          }
        }
      } catch (err) {
        req.app?.get("logger")?.warn?.({ err }, "catalog.search db-fallback failed");
      }
    }

    // ---- 3) Rooms/Inventory/Prices from DB (fallback to mock if empty) ----
    // ANCHOR: ROOMS_DB_WIRE_START
    const TIMEBOX_MS = Math.max(500, Number(process.env.CATALOG_ROOMS_TIMEBOX_MS ?? 2500));
    const timebox = <T>(promise: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race([promise, new Promise<T | null>(resolve => setTimeout(() => resolve(null), ms))]);

    for (const p of props) {
      const pid = Number((p as any)?.propertyId);
      if (!Number.isFinite(pid)) continue;

      try {
        const rooms: RoomsDailyRow[] = (await timebox<RoomsDailyRow[]>(
          getRoomsDailyFromDb(pid, params.start, params.end, params.ratePlanId),
          TIMEBOX_MS
        )) ?? [];

        if (rooms.length > 0) {
          // overlay rooms
          if ((p as any).detail && Array.isArray((p as any).detail.rooms)) {
            (p as any).detail.rooms = rooms;
          } else if ((p as any).detail) {
            (p as any).detail.rooms = rooms;
          } else {
            (p as any).detail = { rooms };
          }
          _roomsApplied++; // <— increment after rooms are applied

          // ANCHOR: ROOMS_DB_SOURCE_FLAG
          try { ((p as any).detail as any)._roomsSource = "db"; } catch {}

          // ANCHOR: ROOMS_DB_ROLLUP_FROM_DB (typed)
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
                // Fallback: if no rooms came back from direct DB daily, try adapter details
                // (adapters may resolve partner/profile mapping internally)
                if (rooms.length === 0) {
                  try {
                    const det = await timebox<any>(
                      getDetails({
                        propertyId: pid,
                        start: params.start,
                        end: params.end,
                        ratePlanId: params.ratePlanId,
                      }),
                      TIMEBOX_MS
                    );

                    const maybeRooms: RoomsDailyRow[] =
                      Array.isArray(det?.rooms)
                        ? det.rooms
                        : (Array.isArray(det?.detail?.rooms) ? det.detail.rooms : []);

                    if (maybeRooms.length > 0) {
                      // apply rooms to payload
                      if ((p as any).detail && Array.isArray((p as any).detail.rooms)) {
                        (p as any).detail.rooms = maybeRooms;
                      } else if ((p as any).detail) {
                        (p as any).detail.rooms = maybeRooms;
                      } else {
                        (p as any).detail = { rooms: maybeRooms };
                      }

                      // mark source and bump counter
                      try { ((p as any).detail as any)._roomsSource = "db-adapter"; } catch {}
                      _roomsApplied++;
                    }
                  } catch (e) {
                    req.app?.get("logger")?.warn?.({ e, propertyId: pid }, "rooms-fallback-adapter failed");
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
        const rooms = (p as any)?.detail?.rooms;
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

    // ---- Final: respond ----------------------------------------------------
    return res
      .set("Cache-Control", "no-store")
      .json({
        properties: props,
        _dbg: {
          wantsDb,
          roomsApplied: _roomsApplied,
          guests: req.query.guests ? Number(req.query.guests) : undefined,
          citySel: cityParam || undefined,
          totals: { beforeCity, afterCity }
        }
      });

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
