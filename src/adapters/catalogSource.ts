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

// === DB: property profiles + primary photo (minimal) ======================
import { Client } from "pg";

/** Returns a map keyed by propertyId with {name, city, country, images[]} */
export async function getProfilesFromDb(propertyIds: number[]): Promise<Record<number, {
  name: string; city: string; country: string; images: string[];
}>> {
  if (!propertyIds.length) return {};

  const cs = process.env.DATABASE_URL || "";
  const wantsSSL = /\bsslmode=require\b/i.test(cs) || /render\.com/i.test(cs);
  const client = new Client({ connectionString: cs, ssl: wantsSSL ? { rejectUnauthorized: false } : undefined });
  await client.connect();

  // 1) basic profile
  const prof = await client.query(
    `select id as "propertyId", name, city, country
       from extranet.property
      where id = any($1::int[])`,
    [propertyIds]
  );

  // 2) photos (grab first by sort or created_at)
  const photos = await client.query(
    `select property_id as "propertyId", url
       from extranet.property_photos
      where property_id = any($1::int[])
      order by property_id, sort_order nulls last, created_at`,
    [propertyIds]
  );

  await client.end();

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
