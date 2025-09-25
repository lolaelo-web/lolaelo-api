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
  try {
    const mod: any = await loadHotelsMock();
    const fn = mod?.getAvailability ?? mod?.default?.getAvailability;
    if (typeof fn !== "function") return null;
    return fn({
      propertyId: args.propertyId,
      start: args.start,
      end: args.end,
      ratePlanId: args.ratePlanId ?? 1,
      currency: mod?.CURRENCY || "USD",
    });
  } catch {
    // degrade gracefully if mock fails to load
    return null;
  }
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
import { pool } from "../db/pool.js";
// ANCHOR: DB_IMPORT_PRISMA
import { prisma } from "../prisma.js";

/** Returns a map keyed by propertyId with {name, city, country, images[]} */
export async function getProfilesFromDb(propertyIds: number[]): Promise<Record<number, {
  name: string; city: string; country: string; images: string[];
}>> {
  if (!propertyIds.length) return {};

  // 1) basic profile
  const prof = await pool.query(
    `select id as "propertyId", name, city, country
       from extranet.property
      where id = any($1::int[])`,
    [propertyIds]
  );

  // 2) photos (grab first by sort or created_at)
  const photos = await pool.query(
    `select property_id as "propertyId", url
       from extranet.property_photos
      where property_id = any($1::int[])
      order by property_id, sort_order nulls last, created_at`,
    [propertyIds]
  );

  const out: Record<number, { name: string; city: string; country: string; images: string[] }> = {};
  for (const r of prof.rows) {
    out[r.propertyId] = { name: r.name ?? "", city: r.city ?? "", country: r.country ?? "", images: [] };
  }
  for (const p of photos.rows) {
    if (!out[p.propertyId]) continue;
    if (p.url) out[p.propertyId].images.push(String(p.url));
  }
  return out;
}

// === DB: rooms inventory + prices (daily) ===================================
// Returns the same shape your mock 'roomsDaily' uses.
// Assumes 'propertyId' maps to Partner.id (your schema has no Property model).
// ANCHOR: ROOMS_DAILY_TYPE
export interface RoomsDailyRow {
  roomId: number;
  roomName: string;
  // Enriched daily shape for UI table compatibility
  daily: Array<{
    date: string;
    inventory: number;
    price: number | null;
    currency: string | null;
    open?: number;          // same as inventory
    closed?: boolean;       // derived from isClosed || open<=0
    minStay?: number | null;
  }>;
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
  ratePlanId?: number
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

  // 1) Room masters for this partner (active only)
  const roomTypes = await prisma.roomType.findMany({
    where: { partnerId: propertyId, active: true },
    select: { id: true, name: true, basePrice: true },
    orderBy: { id: "asc" },
  });
  if (roomTypes.length === 0) return [];

  const roomTypeIds = roomTypes.map(r => r.id);

  // 2) Determine preferred rate plan per roomType if none provided
  const preferredPlanByRoom: Record<number, number | null> = {};
  if (typeof ratePlanId === "number") {
    for (const rt of roomTypes) preferredPlanByRoom[rt.id] = ratePlanId;
  } else {
    const plans = await prisma.ratePlan.findMany({
      where: { partnerId: propertyId, roomTypeId: { in: roomTypeIds }, exposeToUis: true },
      select: { id: true, roomTypeId: true, uisPriority: true },
      orderBy: [{ roomTypeId: "asc" }, { uisPriority: "asc" }, { id: "asc" }],
    });
    for (const rt of roomTypes) preferredPlanByRoom[rt.id] = null;
    for (const p of plans) {
      if (preferredPlanByRoom[p.roomTypeId] == null) preferredPlanByRoom[p.roomTypeId] = p.id;
    }
  }

  // 3) Pull inventory rows in range (include minStay)
  const invRows = await prisma.roomInventory.findMany({
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
  const priceRows = await prisma.roomPrice.findMany({
    where: {
      roomTypeId: { in: roomTypeIds },
      date: { gte: new Date(startISO + "T00:00:00Z"), lt: new Date(endISO + "T00:00:00Z") },
      OR: planIds.length
        ? [{ ratePlanId: { in: planIds } }, { ratePlanId: null }]
        : [{ ratePlanId: null }],
    },
    select: { roomTypeId: true, ratePlanId: true, date: true, price: true },
  });

  // Index: keep exact plan prices separate from null-plan prices
  const priceByPlan = new Map<string, number>(); // key: `${roomTypeId}|${date}|plan|<id>` -> price
  const priceNull   = new Map<string, number>(); // key: `${roomTypeId}|${date}|null`       -> price
  for (const r of priceRows) {
    const d = r.date.toISOString().slice(0, 10);
    const major = Number(r.price); // Decimal -> number
    if (r.ratePlanId == null) {
      const k = `${r.roomTypeId}|${d}|null`;
      if (!priceNull.has(k)) priceNull.set(k, major);
    } else {
      const k = `${r.roomTypeId}|${d}|plan|${r.ratePlanId}`;
      if (!priceByPlan.has(k)) priceByPlan.set(k, major);
    }
  }

  // 5) Build output, covering all dates; price preference: specified plan → preferred exposeToUis plan → null plan → basePrice
  const out: RoomsDailyRow[] = [];
  for (const rt of roomTypes) {
    const prefPlanId = preferredPlanByRoom[rt.id] ?? null;

    const daily = dates.map((d) => {
      // price lookup
      let price: number | null = null;
      if (prefPlanId != null) {
        price = priceByPlan.get(`${rt.id}|${d}|plan|${prefPlanId}`) ?? null;
      }
      if (price == null) {
        // try any plan price for that date
        for (const [k, v] of priceByPlan) {
          if (k.startsWith(`${rt.id}|${d}|plan|`)) { price = v; break; }
        }
      }
      if (price == null) price = priceNull.get(`${rt.id}|${d}|null`) ?? null;
      if (price == null) price = Number(rt.basePrice);

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

    out.push({ roomId: rt.id, roomName: rt.name, daily });
  }

  // If zero signal across the board, let caller decide to fall back to mock
  const hasSignal = out.some(r => r.daily.some(d => d.inventory > 0 || d.price != null));
  return hasSignal ? out : [];
}
// === END DB: rooms inventory + prices ======================================
