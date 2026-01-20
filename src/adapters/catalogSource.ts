// src/adapters/catalogSource.ts
// Thin adapter layer used by /catalog/search and /catalog/details.
// For now this wraps the mock module; later we'll swap to Partner Hub DB.

import type { Currency } from "../readmodels/catalog.js";

export type ISODate = string;

export interface SearchArgs {
  start: ISODate;
  end: ISODate;
  ratePlanId?: number;
}

export interface DetailsArgs extends SearchArgs {
  propertyId: number;
  roomId?: number;
  plans?: number;
}

// ANCHOR: LOAD_HOTELS_MOCK
async function loadHotelsMock(): Promise<any> {
  const attempts = [
    "../data/siargao_hotels.js",        // when data/ is under dist/
    "../../data/siargao_hotels.js",     // when copied to dist/data
    "../../../data/siargao_hotels.js",  // when data/ is at project root
  ];
  let lastErr: any;
  for (const rel of attempts) {
    try {
      return await import(rel);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("siargao_hotels.js not found");
}

// ANCHOR: GET_SEARCH_LIST
export async function getSearchList(args: SearchArgs): Promise<any> {
  try {
    const mod: any = await loadHotelsMock();
    const fn = mod?.searchAvailability ?? mod?.default?.searchAvailability;
    if (typeof fn !== "function") return { properties: [] };
    return fn({
      start: args.start,
      end: args.end,
      ratePlanId: args.ratePlanId ?? 1,
      currency: mod?.CURRENCY || "USD",
    });
  } catch {
    // if mock fails to load, degrade to empty list (prevents 500)
    return { properties: [] };
  }
}
// ANCHOR: GET_DETAILS
export async function getDetails(args: DetailsArgs): Promise<any | null> {
  let base: any = null;

  // 1) Keep existing behavior: try mock first (preserves meta/images/addons)
  try {
    const mod: any = await loadHotelsMock();
    const fn = mod?.getAvailability ?? mod?.default?.getAvailability;
    if (typeof fn === "function") {
      base = await fn({
        propertyId: args.propertyId,
        start: args.start,
        end: args.end,
        ratePlanId: args.ratePlanId ?? 1,
        currency: mod?.CURRENCY || "USD",
      });
    }
  } catch {
    base = null;
  }

  // 2) DB ROOMS INJECTION (CANONICAL)
  // Always populate base.rooms from DB so RoomType metadata is consistent across clients.
  // Keep checkoutQuote behavior: only add checkoutQuote when quoteMode && rp !== 1.
  try {
    const quoteMode = Number(args?.plans) === 2;

    // Option 2: if no ratePlanId was provided, do NOT force STD here.
    // Pass undefined so getRoomsDailyFromDb can pull all plan rows for the window.
    const requestedRatePlanId =
      typeof (args as any)?.ratePlanId === "number"
        ? Number((args as any).ratePlanId)
        : undefined;

    // Preserve prior checkoutQuote behavior: rp defaults to 1 when unspecified
    const rpForQuote = Number.isFinite(requestedRatePlanId as any)
      ? (requestedRatePlanId as number)
      : 1;

    const roomsDaily = await getRoomsDailyFromDb(
      args.propertyId,
      args.start,
      args.end,
      requestedRatePlanId,
      { persistDerived: true } // DETAILS ONLY
    );

    if (roomsDaily && roomsDaily.length) {
      const rooms = roomsDaily.map(r => ({
        roomTypeId: r.roomId,
        id: r.roomId,
        name: r.roomName,
        daily: r.daily,
        dailyByPlanId: r.dailyByPlanId,

        // RoomType metadata (canonical: extranet."RoomType")
        summary: r.summary ?? null,
        size_sqm: r.size_sqm ?? null,
        size_sqft: r.size_sqft ?? null,
        details_keys: r.details_keys ?? [],
        details_text: r.details_text ?? null,
        inclusion_keys: r.inclusion_keys ?? [],
        inclusion_text: r.inclusion_text ?? null,
      }));

      const out: any =
        base && typeof base === "object"
          ? { ...base }
          : { partnerId: args.propertyId };

      out.rooms = rooms;
      out._roomsSource = "db";

      // Optional: checkoutQuote (preserve old behavior)
      if (quoteMode && rpForQuote !== 1) {
        const pickId =
          args.roomId != null ? Number(args.roomId) : undefined;

        const chosen =
          (Number.isFinite(pickId as any)
            ? rooms.find(r => Number(r.roomTypeId) === Number(pickId))
            : null) || rooms[0];

        const daily = Array.isArray((chosen as any)?.daily)
          ? (chosen as any).daily
          : [];

        const nights = daily
          .filter((d: any) =>
            d &&
            d.date &&
            d.price != null &&
            Number.isFinite(Number(d.price)) &&
            Number(d.price) > 0
          )
          .map((d: any) => ({
            date: String(d.date),
            amount: Number(d.price),
          }));

        const total = nights.reduce((s: number, n: any) => s + n.amount, 0);

        const curRow = daily.find((d: any) => d && d.currency) || null;
        const currency = curRow?.currency ? String(curRow.currency) : "USD";

        const checkoutQuote =
          nights.length && Number.isFinite(total) && total > 0
            ? {
                source: "db",
                currency,
                total,
                nights,
                roomTypeId: Number((chosen as any).roomTypeId),
                ratePlanId: rpForQuote,
              }
            : null;

        if (checkoutQuote) out.checkoutQuote = checkoutQuote;
      }

      // keep addons shape stable
      if (!Array.isArray(out.addons)) out.addons = [];

      base = out;
    }
  } catch {
    // intentionally swallow – do not affect non-checkout paths
  }

  // 3) Return base (mock, or mock + gated DB rooms/quote)
  return base;
}

// ANCHOR: GET_CURRENCY
export async function getCurrency(): Promise<Currency> {
  try {
    const mod: any = await loadHotelsMock();
    return (mod?.CURRENCY ?? "USD") as Currency;
  } catch {
    // fallback if mock cannot be loaded
    return "USD" as Currency;
  }
}

// === DB: property profiles + primary photo (minimal) ======================
// ANCHOR: DB_IMPORT_POOL
import { pool } from "../db/pool.js"; // (kept; may be used elsewhere)
// ANCHOR: DB_IMPORT_PRISMA
import { prisma } from "../prisma.js";

/** Returns a map keyed by propertyId with {name, city, country, images[]} */
export async function getProfilesFromDb(propertyIds: number[]): Promise<Record<number, {
  name?: string; city?: string; country?: string; images: string[];
}>> {
  if (!Array.isArray(propertyIds) || propertyIds.length === 0) return {};

  const out: Record<number, { name?: string; city?: string; country?: string; images: string[] }> = {};

  // 1) Profiles from extranet.PropertyProfile (keyed by partnerId)
  const profiles = await prisma.propertyProfile.findMany({
    where: { partnerId: { in: propertyIds } },
    select: { partnerId: true, name: true, city: true, country: true },
  });
  console.log("[getProfilesFromDb] profiles", { ids: propertyIds, found: profiles.length });

  for (const p of profiles) {
    out[p.partnerId] = {
      name: p.name ?? undefined,
      city: p.city ?? undefined,
      country: p.country ?? undefined,
      images: [],
    };
  }

  // 2) Photos from extranet.PropertyPhoto (cover first, then sortOrder, then id)
  const photos = await prisma.extranet_PropertyPhoto.findMany({
    where: { partnerId: { in: propertyIds } },
    select: { partnerId: true, url: true, isCover: true, sortOrder: true, id: true },
    orderBy: [{ isCover: "desc" }, { sortOrder: "asc" }, { id: "asc" }],
  });
  console.log("[getProfilesFromDb] photos", { ids: propertyIds, found: photos.length, sample: photos[0]?.partnerId });

  for (const ph of photos) {
    if (!out[ph.partnerId]) out[ph.partnerId] = { images: [] } as any;
    if (!out[ph.partnerId].images) out[ph.partnerId].images = [];
    if (ph.url) out[ph.partnerId].images.push(ph.url);
  }

  return out;
}

// === DB: rooms inventory + prices (daily) ===================================
// Returns the same shape your mock 'roomsDaily' uses.
// Assumes 'propertyId' maps to Partner.id (your schema has no Property model).
// ANCHOR: ROOMS_DAILY_TYPE
export type DailyCell = {
  date: string;
  inventory: number;
  price: number | null;
  currency: string | null;
  open?: number;
  closed?: boolean;
  minStay?: number | null;
};

export interface RoomsDailyRow {
  roomId: number;
  roomName: string;

  // RoomType metadata (canonical: extranet."RoomType")
  summary?: string | null;
  size_sqm?: number | null;
  size_sqft?: number | null;
  details_keys?: string[] | null;
  details_text?: string | null;
  inclusion_keys?: string[] | null;
  inclusion_text?: string | null;

  // Enriched daily shape for UI table compatibility
  daily: DailyCell[];

  // Option 2: per-plan daily payload (keyed by ratePlanId)
  dailyByPlanId?: Record<number, DailyCell[]>;
}


/**
 * getRoomsDailyFromDb
 * @param propertyId  Partner.id (acts as "property" in catalog)
 * @param startISO    "YYYY-MM-DD"
 * @param endISO      "YYYY-MM-DD" (exclusive)
 * @param ratePlanId  optional preferred RatePlan.id; if omitted, picks first exposeToUis by lowest uisPriority; falls back to null rate and then RoomType.basePrice
 */
export async function getRoomsDailyFromDb(
  propertyId: number,
  startISO: string,
  endISO: string,
  ratePlanId?: number,
  opts?: { persistDerived?: boolean }
): Promise<RoomsDailyRow[]> {
  // 0) Build full date list (UTC, inclusive start, exclusive end)
  const dates: string[] = [];
  {
    const start = new Date(startISO + "T00:00:00Z");
    const end = new Date(endISO + "T00:00:00Z");
    for (let d = new Date(start); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }
  }
  if (dates.length === 0) return [];

  // 1) Room masters for this partner (do not filter by `active` to avoid schema drift)
  // NOTE: We use $queryRaw here because Prisma schema/client may not include the metadata columns yet.
  const roomTypes = await prisma.$queryRaw<Array<{
    id: number;
    name: string;
    basePrice: any;

    summary: string | null;
    size_sqm: number | null;
    size_sqft: number | null;
    details_keys: any;      // jsonb
    details_text: string | null;
    inclusion_keys: any;    // jsonb
    inclusion_text: string | null;
  }>>`
    SELECT
      id,
      name,
      "basePrice",
      summary,
      size_sqm,
      size_sqft,
      details_keys,
      details_text,
      inclusion_keys,
      inclusion_text
    FROM extranet."RoomType"
    WHERE "partnerId" = ${propertyId}
    ORDER BY id ASC
  `;

  if (roomTypes.length === 0) return [];

  const roomTypeIds = roomTypes.map(r => r.id);

  const callerSpecifiedPlan = typeof ratePlanId === "number";
  const persistDerived = opts?.persistDerived === true;

  // Requested plan (kind/value + active/code + roomType scope)
  let requestedPlan: { id: number; roomTypeId: number; code: string; active: boolean; kind: string; value: number } | null = null;
  if (callerSpecifiedPlan) {
    const rp = await prisma.extranet_RatePlan.findUnique({
      where: { id: ratePlanId as number },
      select: { id: true, roomTypeId: true, code: true, active: true, kind: true, value: true },
    });

    if (rp && rp.kind != null) {
      requestedPlan = {
        id: Number(rp.id),
        roomTypeId: Number(rp.roomTypeId),
        code: String(rp.code || "").toUpperCase(),
        active: rp.active === true,
        kind: String(rp.kind || ""),
        value: Number(rp.value ?? 0),
      };
    }
  }

  const requestedPlanRule: { kind: string; value: number } | null =
  requestedPlan ? { kind: requestedPlan.kind, value: requestedPlan.value } : null;

  // STD plan id per roomType (STD is the plan named "Standard")
  const stdPlanByRoomType = new Map<number, number>();
  {
    const stdPlans = await prisma.extranet_RatePlan.findMany({
      where: {
        partnerId: propertyId,
        roomTypeId: { in: roomTypeIds },
        code: "STD",
      },
      select: { id: true, roomTypeId: true },
    });
    for (const p of stdPlans) stdPlanByRoomType.set(p.roomTypeId, p.id);
  }

  // Active derived plans (non-STD) per roomType
  const activePlansByRoomType = new Map<
    number,
    Array<{ id: number; kind: string; value: number; code: string }>
  >();

  {
    const plans = await prisma.extranet_RatePlan.findMany({
      where: {
        partnerId: propertyId,
        roomTypeId: { in: roomTypeIds },
        active: true,
        NOT: { code: "STD" },
      },
      select: {
        id: true,
        roomTypeId: true,
        kind: true,
        value: true,
        code: true,
      },
      orderBy: { id: "asc" },
    });

    for (const p of plans) {
      const rtId = Number(p.roomTypeId);
      let arr = activePlansByRoomType.get(rtId);
      if (!arr) {
        arr = [];
        activePlansByRoomType.set(rtId, arr);
      }
      arr.push({
        id: Number(p.id),
        kind: String(p.kind || ""),
        value: Number(p.value ?? 0),
        code: String(p.code || "").toUpperCase(),
      });
    }
  }

  function applyPlanRule(base: number, rule: { kind: string; value: number } | null): number {
    if (!Number.isFinite(base)) return base;
    if (!rule) return base;

    const kind = String(rule.kind || "").toUpperCase();
    const v = Number(rule.value);

    if (kind === "ABSOLUTE") return base + (Number.isFinite(v) ? v : 0);
    if (kind === "PERCENT")  return base * (1 + ((Number.isFinite(v) ? v : 0) / 100));
    return base; // NONE/unknown
  }

  // 2) Determine preferred rate plan per roomType if none provided
  const preferredPlanByRoom: Record<number, number | null> = {};

  if (typeof ratePlanId === "number") {
    // If caller specified a ratePlanId, use it for every room
    for (const rt of roomTypes) {
      preferredPlanByRoom[rt.id] = ratePlanId;
    }
  } else {
    // In the extranet schema, RatePlan does NOT have exposeToUis / uisPriority.
    // We just pick the first plan per roomType (sorted by id).
    const plans = await prisma.extranet_RatePlan.findMany({
      where: {
        partnerId: propertyId,
        roomTypeId: { in: roomTypeIds },
      },
      select: {
        id: true,
        roomTypeId: true,
      },
      orderBy: [
        { roomTypeId: "asc" },
        { id: "asc" },
      ],
    });

    // init with null
    for (const rt of roomTypes) {
      preferredPlanByRoom[rt.id] = null;
    }
    // first plan per roomType wins
    for (const p of plans) {
      if (preferredPlanByRoom[p.roomTypeId] == null) {
        preferredPlanByRoom[p.roomTypeId] = p.id;
      }
    }
  }

  // 3) Pull inventory rows in range (include minStay)
  const invRows = await prisma.extranet_RoomInventory.findMany({
    where: {
      roomTypeId: { in: roomTypeIds },
      date: { gte: new Date(startISO + "T00:00:00Z"), lt: new Date(endISO + "T00:00:00Z") },
    },
    // ANCHOR: INV_SELECT_FIELDS
    select: { roomTypeId: true, date: true, roomsOpen: true, isClosed: true, minStay: true },
  });

  // ANCHOR: INV_INDEX_STRUCT
  type InvRec = { open: number; closed: boolean; minStay: number | null };
  // Index: `${roomTypeId}|YYYY-MM-DD` -> {open, closed, minStay}
  const invIdx = new Map<string, InvRec>();
  for (const r of invRows) {
    const d = r.date.toISOString().slice(0, 10);
    const open = Math.max(0, r.isClosed ? 0 : (r.roomsOpen ?? 0));
    invIdx.set(`${r.roomTypeId}|${d}`, {
      open,
      closed: !!r.isClosed || open <= 0,
      minStay: r.minStay ?? null,
    });
  }

  // 4) Pull price rows in range. We’ll fetch:
  //    a) rows for preferred plan (if any), and
  //    b) rows with null ratePlanId, as a fallback.
  const planIds = Array.from(
    new Set(Object.values(preferredPlanByRoom).filter((v): v is number => typeof v === "number"))
  );

  // Always include STD plan ids so we can derive from STD when plan rows are missing
  for (const rtId of roomTypeIds) {
    const stdId = stdPlanByRoomType.get(rtId);
    if (typeof stdId === "number") planIds.push(stdId);
  }

  // De-dupe after adding STD ids
  const planIdsDeduped = Array.from(new Set(planIds));

  const priceRows = await prisma.extranet_RoomPrice.findMany({
    where: {
      roomTypeId: { in: roomTypeIds },
      date: {
        gte: new Date(startISO + "T00:00:00Z"),
        lt: new Date(endISO + "T00:00:00Z"),
      },
      ...(planIdsDeduped.length
        ? { ratePlanId: { in: planIdsDeduped } }
        : {}),
    },
    select: { roomTypeId: true, ratePlanId: true, date: true, price: true },
  });

  // Index: `${roomTypeId}|${date}|plan|<id>` -> price
  const priceByPlan = new Map<string, number>();
  const planIdsByRoomType = new Map<number, Set<number>>();

  for (const r of priceRows) {
    const d = r.date.toISOString().slice(0, 10);
    const major = Number(r.price); // Decimal -> number
    const rtId = Number(r.roomTypeId);
    const pid = Number(r.ratePlanId);

    const k = `${rtId}|${d}|plan|${pid}`;
    if (!priceByPlan.has(k)) priceByPlan.set(k, major);

    let s = planIdsByRoomType.get(rtId);
    if (!s) { s = new Set<number>(); planIdsByRoomType.set(rtId, s); }
    if (Number.isFinite(pid)) s.add(pid);
  }

  // 5) Build output, covering all dates; price preference: specified plan → preferred exposeToUis plan → null plan → basePrice
  const out: RoomsDailyRow[] = [];
  for (const rt of roomTypes) {
    const prefPlanId = preferredPlanByRoom[rt.id] ?? null;

  const stdSeedRows: Array<{ partnerId: number; roomTypeId: number; ratePlanId: number; date: Date; price: number }> = [];
  const derivedRows: Array<{ partnerId: number; roomTypeId: number; ratePlanId: number; date: Date; price: number }> = [];

  function withinRollingWindow(iso: string): boolean {
    // match prices/bulk window: today-2 through today+183
    const t = new Date();
    const min = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
    min.setUTCDate(min.getUTCDate() - 2);

    const max = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
    max.setUTCDate(max.getUTCDate() + 183);

    const dt = new Date(iso + "T00:00:00Z");
    return dt >= min && dt <= max;
  }

  // Derive-on-demand (Strategy 1): materialize ALL active derived plans for this roomType in-window (insert-only)
  if (persistDerived) {
    const stdId = stdPlanByRoomType.get(rt.id) ?? null;
    const plans = activePlansByRoomType.get(rt.id) || [];

    for (const d of dates) {
      if (!withinRollingWindow(d)) continue;

      // Effective STD for the day (prefer DB row; seed basePrice only if missing)
      let stdPrice: number | null = null;
      if (stdId != null) {
        stdPrice = priceByPlan.get(`${rt.id}|${d}|plan|${stdId}`) ?? null;
      }

      if (stdPrice == null) {
        const bp = Number(rt.basePrice);
        if (stdId != null && Number.isFinite(bp)) {
          stdSeedRows.push({
            partnerId: propertyId,
            roomTypeId: rt.id,
            ratePlanId: stdId,
            date: new Date(d + "T00:00:00Z"),
            price: bp,
          });
          // Make it available in this response without a second fetch
          priceByPlan.set(`${rt.id}|${d}|plan|${stdId}`, bp);
          let s = planIdsByRoomType.get(rt.id);
          if (!s) { s = new Set<number>(); planIdsByRoomType.set(rt.id, s); }
          s.add(stdId);
        }
        stdPrice = Number.isFinite(bp) ? bp : null;
      }

      if (stdPrice == null) continue;

      for (const p of plans) {
        const key = `${rt.id}|${d}|plan|${p.id}`;
        if (priceByPlan.has(key)) continue; // never overwrite

        // Apply rule
        let derived = stdPrice;
        if (p.kind === "ABSOLUTE") {
          derived = Number(stdPrice) + Number(p.value);
        } else if (p.kind === "PERCENT") {
          derived = Number(stdPrice) * (1 + (Number(p.value) / 100));
        }

        if (!Number.isFinite(Number(derived))) continue;

        derivedRows.push({
          partnerId: propertyId,
          roomTypeId: rt.id,
          ratePlanId: p.id,
          date: new Date(d + "T00:00:00Z"),
          price: Number(derived),
        });

        // Make it available in this response without a second fetch
        priceByPlan.set(key, Number(derived));
        let s = planIdsByRoomType.get(rt.id);
        if (!s) { s = new Set<number>(); planIdsByRoomType.set(rt.id, s); }
        s.add(p.id);
      }
    }
  }

  const daily = dates.map((d) => {
    let price: number | null = null;

    // 1) Try requested plan price (if present)
    if (prefPlanId != null) {
      price = priceByPlan.get(`${rt.id}|${d}|plan|${prefPlanId}`) ?? null;
    }

    // 2) Strategy 1: if caller specified a plan and it's missing:
    // - ONLY derive+persist when persistDerived=true AND plan is active AND in rolling window
    // - Otherwise, leave null (no basePrice fallback for derived plans)
    if (price == null && callerSpecifiedPlan) {
      const planOk =
        persistDerived &&
        requestedPlan != null &&
        requestedPlan.active === true &&
        requestedPlan.code !== "STD" &&
        requestedPlan.roomTypeId === rt.id &&
        withinRollingWindow(d);

      if (planOk) {
        const stdId = stdPlanByRoomType.get(rt.id) ?? null;

        // Determine effective STD price for this date
        let stdPrice: number | null = null;
        if (stdId != null) {
          stdPrice = priceByPlan.get(`${rt.id}|${d}|plan|${stdId}`) ?? null;
        }

        // If STD row missing, seed it insert-only (basePrice) and use basePrice as effective STD
        if (stdPrice == null) {
          const bp = Number(rt.basePrice);
          if (stdId != null && Number.isFinite(bp)) {
            stdSeedRows.push({
              partnerId: propertyId,
              roomTypeId: rt.id,
              ratePlanId: stdId,
              date: new Date(d + "T00:00:00Z"),
              price: bp,
            });
          }
          stdPrice = Number.isFinite(bp) ? bp : null;
        }

        // Derive and persist insert-only
        if (stdPrice != null && Number.isFinite(Number(stdPrice))) {
          const derived = applyPlanRule(Number(stdPrice), requestedPlanRule);
          if (Number.isFinite(derived)) {
            derivedRows.push({
              partnerId: propertyId,
              roomTypeId: rt.id,
              ratePlanId: ratePlanId as number,
              date: new Date(d + "T00:00:00Z"),
              price: derived,
            });
            price = derived; // return derived value; persistence is insert-only below
          }
        }
      }

      // If plan not OK or derivation failed, keep price as null (no fallback)
    }

    // 3) If no specific plan requested, legacy fallback is allowed
    if (price == null && !callerSpecifiedPlan) {
      for (const [k, v] of priceByPlan) {
        if (k.startsWith(`${rt.id}|${d}|plan|`)) { price = v; break; }
      }
    }

    // 4) Final fallback only for non-caller-specified cases
    if (price == null && !callerSpecifiedPlan) price = Number(rt.basePrice);

    // inventory+flags
    // ANCHOR: DAILY_SHAPE_ENRICHED
    const rec = invIdx.get(`${rt.id}|${d}`) ?? { open: 0, closed: true, minStay: null };
    return {
      date: d,
      inventory: rec.open,
      price,
      currency: null,
      open: rec.open,
      closed: rec.closed,
      minStay: rec.minStay,
    };
  });

  // Persist insert-only (Strategy 1): seed missing STD + insert missing derived rows
  if (persistDerived && derivedRows.length) {
    if (stdSeedRows.length) {
      await prisma.extranet_RoomPrice.createMany({
        data: stdSeedRows,
        skipDuplicates: true,
      });
    }
    await prisma.extranet_RoomPrice.createMany({
      data: derivedRows,
      skipDuplicates: true,
    });
  }

    // Normalize jsonb array fields coming from $queryRaw so the UI always gets arrays
    const dk: any = (rt as any).details_keys;
    const ik: any = (rt as any).inclusion_keys;

    const detailsKeysArr: string[] =
      Array.isArray(dk) ? dk.map((x: any) => String(x)).filter(Boolean)
      : (dk && typeof dk === "object" && Array.isArray((dk as any).value))
        ? (dk as any).value.map((x: any) => String(x)).filter(Boolean)
      : [];

    const inclusionKeysArr: string[] =
      Array.isArray(ik) ? ik.map((x: any) => String(x)).filter(Boolean)
      : (ik && typeof ik === "object" && Array.isArray((ik as any).value))
        ? (ik as any).value.map((x: any) => String(x)).filter(Boolean)
      : [];

    // Option 2 (B-mode): build per-plan daily arrays from DB rows that actually exist in this window
    const dailyByPlanId: Record<number, DailyCell[]> = {};
    const planSet = planIdsByRoomType.get(rt.id) || new Set<number>();

    for (const pid of planSet) {
      const cells: DailyCell[] = dates.map((d) => {
        const p = priceByPlan.get(`${rt.id}|${d}|plan|${pid}`) ?? null;
        const rec = invIdx.get(`${rt.id}|${d}`) ?? { open: 0, closed: true, minStay: null };
        return {
          date: d,
          inventory: rec.open,
          price: p,
          currency: null,
          open: rec.open,
          closed: rec.closed,
          minStay: rec.minStay,
        };
      });

      // B-mode: only include planIds that have at least one priced day in the window
      if (cells.some((c) => c.price != null)) {
        dailyByPlanId[pid] = cells;
      }
    }

    const hasDailyByPlan = Object.keys(dailyByPlanId).length > 0;

    out.push({
      roomId: rt.id,
      roomName: rt.name,

      summary: (rt as any).summary ?? null,
      size_sqm: (rt as any).size_sqm ?? null,
      size_sqft: (rt as any).size_sqft ?? null,

      // Always arrays for keys
      details_keys: detailsKeysArr,
      details_text: (rt as any).details_text ?? null,

      inclusion_keys: inclusionKeysArr,
      inclusion_text: (rt as any).inclusion_text ?? null,

      daily,
      dailyByPlanId: hasDailyByPlan ? dailyByPlanId : undefined,
    });
  }

  // If zero signal across the board, let caller decide to fall back to mock
  const hasSignal = out.some(r => r.daily.some(d => d.inventory > 0 || d.price != null));
  return hasSignal ? out : [];
}
// === END DB: rooms inventory + prices ======================================
// ANCHOR: SEARCH_LIST_DB_START
// Return a base properties array from DB (profile + photos only).
// Rooms/inventory/prices are added later by the route enrichment.
export async function getSearchListFromDb(_params: {
  start: string; end: string; ratePlanId?: number | undefined;
}): Promise<{ properties: Array<any> }> {
  // Load partners with photos
  const partners = await prisma.extranet_Partner.findMany({
    where: { id: { in: [2] } }, // keep only propertyId=2
    include: {
      PropertyPhoto: { orderBy: { sortOrder: "asc" } },
    },
    orderBy: { id: "asc" },
  });

  // Load profiles from extranet.PropertyProfile and map by partnerId
  const partnerIds = partners.map((p) => p.id);
  const profiles = await prisma.propertyProfile.findMany({
    where: { partnerId: { in: partnerIds } },
  });

  const profileByPartnerId = new Map<number, (typeof profiles)[number]>();
  for (const pr of profiles) {
    profileByPartnerId.set(pr.partnerId, pr);
  }

  const properties = partners.map((p) => {
    const profile = profileByPartnerId.get(p.id);

    const images = (p.PropertyPhoto ?? []).map((ph: any) => ({
      url: ph.url,
      alt: ph.alt ?? "",
      isCover: !!ph.isCover,
    }));

    return {
      propertyId: p.id,
      // Prefer PropertyProfile.name/city/country, fall back to Partner.name
      name: profile?.name ?? p.name ?? "",
      city: profile?.city ?? "",
      country: profile?.country ?? "",
      images,
      detail: {}, // rooms will be merged by the route
    };
  });

  return { properties };
}
// ANCHOR: SEARCH_LIST_DB_END
