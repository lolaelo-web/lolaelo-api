# Pricing Model v1 — Materialized Pricing with Partner Authority

## Purpose

This document defines how pricing works in v1 of the Lolaelo platform.  
It exists to prevent ambiguity, regressions, and future rewrites of pricing logic.

**Key principle:**  
Prices are materialized facts stored in the database, not formulas evaluated at read time.

---

## Canonical Data Model

### Source of truth
- All nightly prices live in `extranet."RoomPrice"`.
- Each row is keyed by:
  - `partnerId`
  - `roomTypeId`
  - `ratePlanId`
  - `date`

There is no client-side pricing math.  
There is no display-time pricing math.

---

## Rate Plan Types

- **STD**: Base nightly price
- **Derived plans** (e.g. BRKF, NRF):
  - Defined by rules stored in `extranet."RatePlan"`
  - Rules specify:
    - `kind`: `ABSOLUTE` or `PERCENT`
    - `value`: signed numeric (+10, -10%, etc)
  - Rules are instructions, not live formulas

Derived prices are always persisted as rows in `RoomPrice`.

---

## Core Invariants (Do Not Break)

### 1. `RoomPrice` rows are authoritative
- If a price exists in `RoomPrice`, it must be used as-is.
- No recomputation at read time.

### 2. STD is sacred
- STD prices are never overwritten by derived logic.
- STD can only be written by:
  - partner tile edits
  - partner bulk apply
  - seed-on-GET (insert-only from `RoomType.basePrice`)

### 3. Derived prices are materialized outcomes
- BRKF / NRF rows represent a decision that has already happened
- They do not auto-update when rules change

### 4. Only partner actions may overwrite prices
- Traveler reads may insert missing rows
- Traveler reads may never overwrite existing rows
- Partner saves are the only allowed overwrite path

---

## Traveler Read Behavior (Public Catalog)

### Endpoint
- `/catalog/details`

### Behavior
When a traveler requests pricing for a property and date range:

1. Backend loads STD prices for the requested window.
2. Backend loads requested rate plan prices (if any).
3. If:
   - STD exists
   - requested plan is active
   - derived rows are missing
   - dates fall within the allowed write window  

   then:
   - backend derives missing prices from STD
   - inserts derived rows into `RoomPrice` (insert-only)
   - returns persisted values

4. If derived rows already exist:
   - backend reads and returns them
   - no recompute

5. If derivation is not allowed (inactive plan, out-of-window):
   - backend returns `null` for those dates
   - UI shows “Price unavailable”

Traveler reads can fill gaps, never change existing prices.

---

## Partner Behavior (Extranet)

### Partner Save is authoritative

When a hotel user:
- updates rate plan rules
- clicks **Save Changes**

The system:
1. Re-derives prices from STD using current rules
2. Overwrites derived rows
3. Only for the explicit date window the partner saved

Rule changes do not silently affect dates the partner did not act on.

---

## Accepted v1 Tradeoffs (Intentional)

### Derived prices may become stale
Example:
1. Traveler views future dates → derived prices are created
2. Hotel later updates rules
3. Hotel does not re-save that same date range

Result:
- Old derived prices remain until the hotel touches that window

This is intentional to avoid silent repricing and preserve hotel trust.

---

## Write Guardrails

All pricing writes must respect the rolling window:
- `today - 2 days`
- through `today + ~6 months`

Outside this window:
- no derived rows are written
- no seeding occurs
- prices remain unavailable

---

## What v1 Explicitly Does NOT Do

- No rule versioning
- No automatic invalidation of derived prices
- No recomputation on traveler reads
- No global repricing when rules change
- No client-side pricing math

These may be added post-MVP only with explicit design.

---

## Mental Model

**Prices only change when the hotel saves them.  
Traveler views may fill in missing prices, never rewrite decisions.**

---

## Status

This document defines Pricing v1.  
Any deviation is a bug unless this document is updated first.
