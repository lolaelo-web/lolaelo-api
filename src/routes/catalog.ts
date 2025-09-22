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

export default router;
