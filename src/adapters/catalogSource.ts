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
