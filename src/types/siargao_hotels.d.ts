// src/types/siargao_hotels.d.ts
// Wildcard so it matches ../data/siargao_hotels.js (and any path ending with it)
declare module "*siargao_hotels.js" {
  export const CURRENCY: string;
  export const HOTELS: any[];
  export function getAvailability(args: {
    propertyId: number;
    start: string;
    end: string;
    ratePlanId?: number;
    currency?: string;
  }): any;
  export function searchAvailability(args: {
    start: string;
    end: string;
    ratePlanId?: number;
    currency?: string;
  }): any;
}
