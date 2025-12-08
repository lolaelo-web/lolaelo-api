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

  // 1) Room masters for this partner (do not filter by `active` to avoid schema drift)
  const roomTypes = await prisma.extranet_RoomType.findMany({
    where: { partnerId: propertyId }, // REMOVED: active: true
    select: { id: true, name: true, basePrice: true },
    orderBy: { id: "asc" },
  });

  if (roomTypes.length === 0) return [];

  const roomTypeIds = roomTypes.map(r => r.id);

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
  const priceRows = await prisma.extranet_RoomPrice.findMany({
    where: {
      roomTypeId: { in: roomTypeIds },
      date: {
        gte: new Date(startISO + "T00:00:00Z"),
        lt: new Date(endISO + "T00:00:00Z"),
      },
      // In extranet_RoomPrice, ratePlanId is NOT nullable.
      // If we have preferred planIds, filter by those; otherwise, allow all.
      ...(planIds.length
        ? { ratePlanId: { in: planIds } }
        : {}),
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
