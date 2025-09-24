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

export async function getSearchList(args: SearchArgs): Promise<any> {
  // Lazy import so we can swap implementations later without touching route code
  const mod: any = await import("../data/siargao_hotels.js");
  const fn = mod?.searchAvailability ?? mod?.default?.searchAvailability;
  if (typeof fn !== "function") return { properties: [] };
  return fn({
    start: args.start,
    end: args.end,
    ratePlanId: args.ratePlanId ?? 1,
    currency: mod?.CURRENCY || "USD",
  });
}

export async function getDetails(args: DetailsArgs): Promise<any | null> {
  const mod: any = await import("../data/siargao_hotels.js");
  const fn = mod?.getAvailability ?? mod?.default?.getAvailability;
  if (typeof fn !== "function") return null;
  return fn({
    propertyId: args.propertyId,
    start: args.start,
    end: args.end,
    ratePlanId: args.ratePlanId ?? 1,
    currency: mod?.CURRENCY || "USD",
  });
}

export async function getCurrency(): Promise<Currency> {
  const mod: any = await import("../data/siargao_hotels.js");
  return (mod?.CURRENCY ?? "USD") as Currency; // <- literal type
}

// ANCHOR: DB_IMPORT_PRISMA
import { prisma } from "../prisma.js";

export async function getProfilesFromDb(propertyIds: number[]): Promise<Record<number, {
  name: string; city: string; country: string; images: string[];
}>> {
  if (!propertyIds.length) return {};
  try {
    // 1) Partner + Profile (name/city/country)
    const partners = await prisma.partner.findMany({
      where: { id: { in: propertyIds } },
      select: {
        id: true,
        profile: { select: { name: true, city: true, country: true } },
      },
      orderBy: { id: "asc" },
    });

    // 2) Photos (ordered by sortOrder then id)
    const photos = await prisma.propertyPhoto.findMany({
      where: { partnerId: { in: propertyIds } },
      select: { partnerId: true, url: true, sortOrder: true, id: true },
      orderBy: [{ partnerId: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    });

    const out: Record<number, { name: string; city: string; country: string; images: string[] }> = {};
    for (const p of partners) {
      out[p.id] = {
        name: p.profile?.name ?? "",
        city: p.profile?.city ?? "",
        country: p.profile?.country ?? "",
        images: [],
      };
    }

    for (const ph of photos) {
      if (!out[ph.partnerId]) continue;
      if (ph.url) out[ph.partnerId].images.push(String(ph.url));
    }

    return out;
  } catch (err) {
    // Soft-fail to keep endpoint alive; caller will keep mock data
    // (Logger lives on the server; adapters don't have req.app)
    return {};
  }
}

// === DB: rooms inventory + prices (daily) ===================================
// Returns the same shape your mock 'roomsDaily' uses.
// Assumes 'propertyId' maps to Partner.id (your schema has no Property model).
export interface RoomsDailyRow {
  roomId: number;
  roomName: string;
  daily: Array<{ date: string; inventory: number; price: number | null; currency: string | null }>;
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
    // Caller specified a plan; use it for all roomTypes (only rows that exist will match)
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

  // 3) Pull inventory rows in range
  const invRows = await prisma.roomInventory.findMany({
    where: {
      roomTypeId: { in: roomTypeIds },
      date: { gte: new Date(startISO + "T00:00:00Z"), lt: new Date(endISO + "T00:00:00Z") },
    },
    select: { roomTypeId: true, date: true, roomsOpen: true, isClosed: true },
  });

  // Index: `${roomTypeId}|YYYY-MM-DD` -> inventory number (0 if closed or missing)
  const invIdx = new Map<string, number>();
  for (const r of invRows) {
    const d = r.date.toISOString().slice(0, 10);
    const qty = r.isClosed ? 0 : Math.max(0, r.roomsOpen ?? 0);
    invIdx.set(`${r.roomTypeId}|${d}`, qty);
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

  // Index: prefer explicit selected plan, else null plan
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
      const inv = invIdx.get(`${rt.id}|${d}`) ?? 0;

      let price: number | null = null;
      if (prefPlanId) {
        // try exact preferred plan
        price = priceByPlan.get(`${rt.id}|${d}|plan|${prefPlanId}`) ?? null;
      }
      if (price == null) {
        // if no preferred or not found: try any plan for that date (first match)
        for (const [k, v] of priceByPlan) {
          if (k.startsWith(`${rt.id}|${d}|plan|`)) { price = v; break; }
        }
      }
      if (price == null) {
        // null-plan price
        price = priceNull.get(`${rt.id}|${d}|null`) ?? null;
      }
      if (price == null) {
        // base price
        price = Number(rt.basePrice);
      }

      return { date: d, inventory: inv, price, currency: null };
    });

    out.push({ roomId: rt.id, roomName: rt.name, daily });
  }

  // If zero signal across the board, let caller decide to fall back to mock
  const hasSignal = out.some(r => r.daily.some(d => d.inventory > 0 || d.price != null));
  return hasSignal ? out : [];
}
// === END DB: rooms inventory + prices ======================================
