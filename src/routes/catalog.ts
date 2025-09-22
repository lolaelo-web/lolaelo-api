import { Router, type Request, type Response } from "express";
// TS sees this thanks to your src/types/siargao_hotels.d.ts
import * as HotelsData from "../../data/siargao_hotels.js";

const router = Router();

/**
 * GET /catalog/search?start=YYYY-MM-DD&end=YYYY-MM-DD&guests=2
 * Returns mock multi-property availability from siargao_hotels.js
 */
router.get("/search", (req: Request, res: Response) => {
  const start = String(req.query.start || new Date().toISOString().slice(0, 10));
  const end   = String(req.query.end   || start);
  // guests not used by generator yet, but we accept it for future filtering
  const _guests = Number.parseInt(String(req.query.guests ?? "2"), 10) || 2;

  const searchAvailability =
    (HotelsData as any).searchAvailability ??
    (HotelsData as any).default?.searchAvailability;

  const currency =
    (HotelsData as any).CURRENCY ??
    (HotelsData as any).default?.CURRENCY ?? "USD";

  if (typeof searchAvailability !== "function") {
    return res.status(500).json({ ok: false, error: "Mock catalog not available" });
  }

  const out = searchAvailability({ start, end, currency });
  return res.json(out);
});

// GET /catalog/details?propertyId=101&start=YYYY-MM-DD&end=YYYY-MM-DD[&plan=1]
router.get("/details", (req: Request, res: Response) => {
  const propertyId = Number(req.query.propertyId || req.query.id);
  const start      = String(req.query.start || "").slice(0, 10);
  const end        = String(req.query.end   || "").slice(0, 10);
  const ratePlanId = Number(req.query.plan || req.query.ratePlanId || 1);

  if (!propertyId || !start || !end) {
    res.status(400).json({ ok: false, error: "Missing propertyId/start/end" });
    return;
  }

  const getAvailability =
    (HotelsData as any).getAvailability ??
    (HotelsData as any).default?.getAvailability;

  if (typeof getAvailability !== "function") {
    res.status(500).json({ ok: false, error: "getAvailability not available" });
    return;
  }

  const payload = getAvailability({ propertyId, start, end, ratePlanId });
  if (!payload) {
    res.status(404).json({ ok: false, error: "Property not found" });
    return;
  }
  res.json(payload);
});

export default router;
