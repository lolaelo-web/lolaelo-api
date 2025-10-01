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

/** Helper: map PropertyProfile.id -> Partner.id (prefer extranet over public) */
async function mapProfileToPartner(ids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!ids.length) return out;

  const cs = process.env.DATABASE_URL || "";
  if (!cs) return out;

  const wantsSSL = /\bsslmode=require\b/i.test(cs) || /render\.com/i.test(cs);
  const pg = new PgClient({
    connectionString: cs,
    ssl: wantsSSL ? { rejectUnauthorized: false } : undefined,
  });
  await pg.connect();

  const { rows } = await pg.query(
    `
    WITH ids AS (SELECT unnest($1::bigint[]) AS id)
    SELECT 'extranet' AS schema, pp.id AS profile_id, pp."partnerId" AS partner_id
    FROM extranet."PropertyProfile" pp JOIN ids ON ids.id = pp.id
    UNION ALL
    SELECT 'public' AS schema, pp.id AS profile_id, pp."partnerId" AS partner_id
    FROM public."PropertyProfile"   pp JOIN ids ON ids.id = pp.id
    `,
    [Array.from(new Set(ids))]
  );

  // prefer extranet if both exist
  for (const r of rows) {
    const from = Number(r.profile_id);
    const to = Number(r.partner_id);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const existing = out.get(from);
    if (existing == null || String(r.schema) === "extranet") out.set(from, to);
  }

  await pg.end();
  return out;
}

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
    let list: any;
    let _baseSource: "db" | "mock" = "mock";

    if (wantsDb) {
      try {
        list = await getSearchListFromDb(params); // DB-first
        _baseSource = "db";
      } catch {
        list = await getSearchList(params); // fallback to mock
        _baseSource = "mock";
      }
    } else {
      list = await getSearchList(params); // mock when db=0
      _baseSource = "mock";
    }

    const props: any[] = Array.isArray(list?.properties) ? list.properties : [];
    for (const p of props) {
      try {
        (p as any)._baseSource = _baseSource;
      } catch {}
    }
    if (props.length === 0) return res.json({ properties: [] });

    // Normalize/strip legacy id
    for (const p of props) {
      if (p && p.id == null && p.propertyId != null) p.id = p.propertyId;
    }
    for (const p of props) {
      try {
        delete (p as any).id;
      } catch {}
    }

    // ---- 1b) Remap PropertyProfile.id -> Partner.id (once, up front) ----
    try {
      const profileIds = props
        .map((p: any) => Number(p?.propertyId))
        .filter((n: number) => Number.isFinite(n)) as number[];
      const remap = await mapProfileToPartner(profileIds);

      const changes: Array<{ from: number; to: number }> = [];
      for (const p of props) {
        const from = Number((p as any)?.propertyId);
        const to = remap.get(from);
        if (to && to !== from) {
          (p as any).propertyId = to; // switch to Partner.id for the rest of the pipeline
          changes.push({ from, to });
        }
      }
      if (changes.length) console.log("[catalog.search][remap] profile→partner", changes);
    } catch (e) {
      req.app?.get("logger")?.warn?.({ e }, "profile→partner remap failed");
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
          const prof = (profMap as any)?.[pid];
          if (!prof) continue;

          // prefer DB identity/location labels
          (p as any).name = prof.name ?? (p as any).name ?? "";
          (p as any).city = prof.city ?? (p as any).city ?? "";
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
        // Cover image backfill from extranet.PropertyPhoto by Partner.id (only when images are empty)
        try {
          const cs = process.env.DATABASE_URL || "";
          if (cs && ids.length > 0) {
            const wantsSSL = /\bsslmode=require\b/i.test(cs) || /render\.com/i.test(cs);
            const pg = new PgClient({
              connectionString: cs,
              ssl: wantsSSL ? { rejectUnauthorized: false } : undefined,
            });
            await pg.connect();

            const { rows } = await pg.query(
              `
              SELECT DISTINCT ON (p."partnerId")
                    p."partnerId" AS pid,
                    p.url
              FROM extranet."PropertyPhoto" p
              WHERE p."partnerId" = ANY($1::bigint[])
              ORDER BY p."partnerId", p."isCover" DESC NULLS LAST, p."createdAt" DESC NULLS LAST, p.id DESC
              `,
              [ids]
            );

            const cover = new Map<number, string>();
            for (const r of rows) {
              const pid = Number(r.pid);
              const url = r?.url ? String(r.url) : "";
              if (Number.isFinite(pid) && url) cover.set(pid, url);
            }

            for (const p of props) {
              const pid = Number((p as any)?.propertyId);
              const curImgs = (p as any)?.images;
              if (
                Number.isFinite(pid) &&
                (!Array.isArray(curImgs) || curImgs.length === 0)
              ) {
                const url = cover.get(pid);
                if (url) (p as any).images = [url];
              }
            }

            await pg.end();
          }
        } catch (err) {
          req.app?.get("logger")?.warn?.({ err, idsCount: ids.length }, "search.cover-backfill failed");
        }
    // Placeholder image backfill for cards with no images
    try {
      for (const p of props) {
        const imgs = (p as any)?.images;
        if (!Array.isArray(imgs) || imgs.length === 0) {
          // Use a deterministic, local placeholder so UI never shows random stock
          (p as any).images = ["/logo.png"];
        }
      }
    } catch (e) {
      req.app?.get("logger")?.warn?.({ e }, "search.placeholder-backfill failed");
    }

    // ---- 2b) NOW apply server-side CITY FILTER (after enrichment) ----------
    const beforeCity = props.length;
    if (cityParam) {
      for (let i = props.length - 1; i >= 0; i--) {
        const cc = String((props[i] as any)?.cityCode || "").toUpperCase();
        const c = String((props[i] as any)?.city || "").toUpperCase();
        if (cc !== cityParam && c !== cityParam) props.splice(i, 1);
      }
    }
    const afterCity = props.length;

    // If nothing left after enrichment/city filter, try a DB fallback:
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
              p.id                                 AS "propertyId",
              COALESCE(pp.name, p.name, '')        AS name,
              COALESCE(pp.city, '')                AS city,
              ''                                   AS country
            FROM cand c
            JOIN extranet."Partner" p              ON p.id = c.pid
            LEFT JOIN extranet."PropertyProfile" pp ON pp."partnerId" = p.id
          `;

          const { rows } = await pg.query(q, [start, end, ratePlanId ?? null]);
          await pg.end();

          for (const r of rows) {
            if (cityParam) {
              const c = String(r.city || "").toUpperCase();
              if (c !== cityParam) continue;
            }
            props.push({
              propertyId: Number(r.propertyId), // already a Partner.id here
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
      Promise.race([promise, new Promise<T | null>((resolve) => setTimeout(() => resolve(null), ms))]);

    for (const p of props) {
      const pid = Number((p as any)?.propertyId); // this is Partner.id now
      if (!Number.isFinite(pid)) continue;

      try {
        const rooms: RoomsDailyRow[] =
          (await timebox<RoomsDailyRow[]>(
            getRoomsDailyFromDb(pid, params.start, params.end, params.ratePlanId),
            TIMEBOX_MS
          )) ?? [];

        if (rooms.length > 0) {
          if ((p as any).detail && Array.isArray((p as any).detail.rooms)) {
            (p as any).detail.rooms = rooms;
          } else if ((p as any).detail) {
            (p as any).detail.rooms = rooms;
          } else {
            (p as any).detail = { rooms };
          }
          _roomsApplied++;

          try {
            ((p as any).detail as any)._roomsSource = "db";
          } catch {}

          try {
            type Daily = RoomsDailyRow["daily"][number];
            const allDaily: Daily[] = rooms.flatMap((r: RoomsDailyRow) => (r.daily as Daily[]) || []);
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
    return res.set("Cache-Control", "no-store").json({
      properties: props,
      _dbg: {
        wantsDb,
        roomsApplied: _roomsApplied,
        guests: req.query.guests ? Number(req.query.guests) : undefined,
        citySel: cityParam || undefined,
        totals: { beforeCity, afterCity },
      },
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    const stack = err?.stack || null;
    req.app?.get("logger")?.error?.({ err }, "catalog.search failed");
    return res
      .status(500)
      .json({ error: "Internal error", _where: "catalog.search", _debug: msg, _stack: stack });
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
      : req.query.plan
      ? Number(req.query.plan)
      : undefined;

    if (!Number.isFinite(propertyId)) {
      return res.status(400).json({ error: "propertyId must be a number" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return res.status(400).json({ error: "start/end must be YYYY-MM-DD" });
    }

    // Base (mock) details
    let base: any = await getDetails({ propertyId, start, end, ratePlanId });
    if (!base || typeof base !== "object") base = {};
    console.log("[details] start", { propertyId, start, end, ratePlanId });

    // Profiles (name/city/images) — DIRECT SQL using Partner.id for profile + cover photo
    try {
      const partnerId = Number.isFinite(propertyId) ? propertyId : NaN;
      if (!Number.isFinite(partnerId)) throw new Error("invalid partnerId for profiles");

      const cs = process.env.DATABASE_URL || "";
      if (!cs) throw new Error("DATABASE_URL missing");

      const wantsSSL = /\bsslmode=require\b/i.test(cs) || /render\.com/i.test(cs);
      const pg = new PgClient({
        connectionString: cs,
        ssl: wantsSSL ? { rejectUnauthorized: false } : undefined,
      });
      await pg.connect();

      // Prefer extranet profile; fallback to public. Also fetch one cover photo (or latest).
      const q = `
        WITH prof AS (
          SELECT id, name, city, country FROM extranet."PropertyProfile" WHERE "partnerId" = $1
          UNION ALL
          SELECT id, name, city, country FROM public."PropertyProfile"   WHERE "partnerId" = $1
          LIMIT 1
        ),
        pic AS (
          SELECT url
          FROM extranet."PropertyPhoto"
          WHERE "partnerId" = $1
          ORDER BY "isCover" DESC NULLS LAST, "createdAt" DESC NULLS LAST, id DESC
          LIMIT 1
        )
        SELECT
          (SELECT id      FROM prof)    AS profile_id,
          (SELECT name    FROM prof)    AS name,
          (SELECT city    FROM prof)    AS city,
          (SELECT country FROM prof)    AS country,
          (SELECT url     FROM pic)     AS cover_url
      `;
      const { rows } = await pg.query(q, [partnerId]);
      await pg.end();

      const r = rows?.[0] || {};
      if (r) {
        if (r.name)    base.name    = r.name;
        if (r.city)    base.city    = r.city;
        if (r.country) base.country = r.country;

        // Attach cover image if present
        if (r.cover_url) {
          const imgs = Array.isArray(base.images) ? base.images : [];
          base.images = [String(r.cover_url), ...imgs];
        }
      }
    } catch (err) {
      req.app?.get("logger")?.warn?.({ err, propertyId }, "details.profiles-db-direct failed");
    }

    // Rooms from DB (overlay) — DIRECT SQL (bypass adapter) using Partner.id
    try {
      const partnerId = Number.isFinite(propertyId) ? propertyId : NaN;
      if (!Number.isFinite(partnerId)) throw new Error("invalid partnerId for details");

      const cs = process.env.DATABASE_URL || "";
      if (!cs) throw new Error("DATABASE_URL missing");

      const wantsSSL = /\bsslmode=require\b/i.test(cs) || /render\.com/i.test(cs);
      const pg = new PgClient({
        connectionString: cs,
        ssl: wantsSSL ? { rejectUnauthorized: false } : undefined,
      });
      await pg.connect();

      // Pull daily rows for all active room types that have BOTH price and inventory in the window
      const sql = `
        WITH dd AS (
          SELECT generate_series($2::date, ($3::date - INTERVAL '1 day'), INTERVAL '1 day')::date AS d
        ),
        cand_rt AS (
          SELECT DISTINCT rt.id
          FROM extranet."RoomType" rt
          WHERE COALESCE(rt.active, TRUE) = TRUE
            AND rt.id IN (
              SELECT DISTINCT ri."roomTypeId"
              FROM extranet."RoomInventory" ri
              WHERE ri."partnerId" = $1
                AND COALESCE(ri."isClosed", FALSE) = FALSE
                AND COALESCE(ri."roomsOpen", 0) > 0
            )
            AND rt.id IN (
              SELECT DISTINCT rp."roomTypeId"
              FROM extranet."RoomPrice" rp
              WHERE rp."partnerId" = $1
                AND ($4::int IS NULL OR rp."ratePlanId" = $4::int)
            )
        )
        SELECT
          rt.id                         AS room_type_id,
          rt.name                       AS room_name,
          dd.d                          AS date,
          rp.price                      AS price,
          rp."ratePlanId"               AS rate_plan_id,
          COALESCE(ri."roomsOpen", 0)   AS inventory,
          COALESCE(ri."isClosed", FALSE) AS is_closed
        FROM dd
        JOIN cand_rt crt ON 1=1
        JOIN extranet."RoomType" rt ON rt.id = crt.id
        LEFT JOIN extranet."RoomPrice" rp
          ON rp."partnerId" = $1 AND rp."roomTypeId" = rt.id AND rp.date = dd.d
          AND ($4::int IS NULL OR rp."ratePlanId" = $4::int)
        LEFT JOIN extranet."RoomInventory" ri
          ON ri."partnerId" = $1 AND ri."roomTypeId" = rt.id AND ri.date = dd.d
        ORDER BY rt.id, dd.d;
      `;
      const { rows } = await pg.query(sql, [partnerId, start, end, ratePlanId ?? null]);
      await pg.end();

      // Group into RoomsDailyRow[]
      type Daily = RoomsDailyRow["daily"][number];
      const byRoom = new Map<number, { name: string; daily: Daily[] }>();
      for (const r of rows) {
        const rid = Number(r.room_type_id);

        // Coerce price to number if it comes back as text/decimal
        let priceVal: number | null = null;
        if (r.price !== null && r.price !== undefined) {
          const n = Number(r.price);
          priceVal = Number.isNaN(n) ? null : n;
        }

        const rec: Daily = {
          date: r.date ? new Date(r.date).toISOString().slice(0, 10) : undefined,
          price: priceVal,
          inventory: Number(r.inventory ?? 0),
          closed: !!r.is_closed,
          currency: undefined, // backfilled later
        } as any;

        const cur = byRoom.get(rid) ?? { name: String(r.room_name || ""), daily: [] };
        cur.daily.push(rec);
        byRoom.set(rid, cur);
      }

      const dbRooms: RoomsDailyRow[] = Array.from(byRoom.entries()).map(([roomTypeId, v]) => ({
        roomTypeId,
        name: v.name,
        daily: v.daily,
      })) as any;

      console.log("[details] rooms-db-direct", {
        partnerId,
        count: dbRooms.length,
        range: { start, end },
        ratePlanId,
      });

      if (Array.isArray(dbRooms) && dbRooms.length > 0) {
        if (base?.rooms && Array.isArray(base.rooms)) {
          base.rooms = dbRooms;
        } else if (base) {
          base.rooms = dbRooms;
        }
        (base as any)._roomsSource = "db-direct";
      }
    } catch (err) {
      req.app?.get("logger")?.warn?.({ err, propertyId }, "details.rooms-db-direct failed");
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
      roomsSource: (base as any)?._roomsSource ?? null,
    });
    return res.json(base ?? {});
  } catch (err: any) {
    req.app?.get("logger")?.error?.({ err }, "catalog.details failed");
    return res.status(500).json({ error: "Internal error" });
  }
});

export default router;
