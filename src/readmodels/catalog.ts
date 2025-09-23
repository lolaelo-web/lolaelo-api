// src/readmodels/catalog.ts
// Read models that the public Catalog/Details endpoints will return.
// Zero DB calls here — pure types + helpers so routes can map Partner Hub data
// into these stable shapes without changing the front-end renderers.

export type ISODate = string; // "YYYY-MM-DD"
export type Currency = "USD"; // expand later

/** Card/grid item shape for /catalog/search (KEEP STABLE) */
export interface CatalogProperty {
  propertyId: string;
  name: string;
  city: string;
  country: string;

  /** First image should be the cover; rest follow sortOrder */
  images: string[]; // absolute URLs (S3/CDN)

  /** Small set of amenity tags (e.g., ["wifi","pool","beachfront"]) */
  amenities: string[];

  /** nightly price floor over requested range, derived from room/daily */
  fromPrice: number | null;           // raw number, e.g., 149
  fromPriceStr: string;               // formatted, e.g., "$149"

  /** availability summary over requested range */
  nightsTotal: number;                // requested nights, e.g., 3
  availableNights: number;            // nights with at least 1 room open

  /** optional decorations (mock kept for continuity) */
  starRating?: number;

  /** internal / caching optics (not rendered but handy) */
  currency: Currency;                 // "USD"
  updatedAtISO?: string;              // last projection timestamp
}

/** Full details shape for /catalog/details */
export interface CatalogDetails {
  propertyId: string;
  name: string;
  city: string;
  country: string;
  description?: string;

  images: string[];                   // full gallery, cover first
  amenities: string[];

  /** simple policy block (expand later) */
  policies?: {
    checkIn?: string;
    checkOut?: string;
    cancellation?: string;
    houseRules?: string;
  };

  /** room pricing/availability matrix for the selected range */
  rooms: Array<{
    roomTypeId: string;
    name: string;
    maxGuests: number;
    daily: RoomDaily[];               // ordered by date ASC
  }>;

  currency: Currency;                 // "USD"
  updatedAtISO?: string;
}

/** Per-day record used in details.daily */
export interface RoomDaily {
  date: ISODate;        // "2025-11-12"
  price: number | null; // null means not bookable / closed to arrival
  open: boolean;        // open/closed flag
  minStay?: number;     // optional minimum nights
}

/* ======================= Helpers (pure) ======================= */

/** Format a currency number for display (USD only for now) */
export function formatUSD(amount: number | null): string {
  if (amount == null || isNaN(amount as any)) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount);
  } catch {
    // Narrow polyfill fallback
    return `$${Math.round(Number(amount))}`;
  }
}

/**
 * Compute fromPrice and availability summary over a date range
 * given one or more room daily arrays.
 */
export function summarizePricingAndAvailability(
  roomsDaily: RoomDaily[][],
  nightsTotal: number
): { fromPrice: number | null; fromPriceStr: string; availableNights: number } {
  if (!Array.isArray(roomsDaily) || roomsDaily.length === 0 || nightsTotal <= 0) {
    return { fromPrice: null, fromPriceStr: "—", availableNights: 0 };
  }

  // For each date index (0..nightsTotal-1), check if ANY room is open
  let availableNights = 0;
  const perNightMin: number[] = [];

  for (let i = 0; i < nightsTotal; i++) {
    let nightMin: number | null = null;
    let anyOpen = false;

    for (const daily of roomsDaily) {
      const rec = daily[i];
      if (!rec) continue;
      if (rec.open && rec.price != null && !isNaN(rec.price as any)) {
        anyOpen = true;
        nightMin = nightMin == null ? rec.price : Math.min(nightMin, rec.price);
      }
    }

    if (anyOpen) {
      availableNights++;
      if (nightMin != null) perNightMin.push(nightMin);
    }
  }

  const fromPrice = perNightMin.length ? Math.min(...perNightMin) : null;
  const fromPriceStr = formatUSD(fromPrice);
  return { fromPrice, fromPriceStr, availableNights };
}

/**
 * Basic projection for /catalog/search from partner-side inputs.
 * Caller is responsible for:
 *  - selecting the correct date window
 *  - ordering images with cover first
 *  - providing roomsDaily aligned to the requested range (equal length arrays)
 */
export function projectCatalogProperty(args: {
  propertyId: string;
  name: string;
  city: string;
  country: string;
  images: string[];        // cover first
  amenities: string[];
  roomsDaily: RoomDaily[][]; // one array per room type, aligned by date
  nightsTotal: number;
  starRating?: number;
  currency?: Currency;
  updatedAtISO?: string;
}): CatalogProperty {
  const { fromPrice, fromPriceStr, availableNights } = summarizePricingAndAvailability(
    args.roomsDaily,
    args.nightsTotal
  );

  return {
    propertyId: args.propertyId,
    name: args.name,
    city: args.city,
    country: args.country,
    images: args.images || [],
    amenities: args.amenities || [],
    fromPrice,
    fromPriceStr,
    nightsTotal: args.nightsTotal,
    availableNights,
    starRating: args.starRating,
    currency: args.currency || "USD",
    updatedAtISO: args.updatedAtISO,
  };
}
