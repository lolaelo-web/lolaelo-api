import { NextFunction, Request, Response } from "express";

/**
 * Temporary write gate:
 * - Allows GET/HEAD/OPTIONS
 * - Blocks POST/PUT/PATCH/DELETE unless Authorization: Bearer <EXTRANET_WRITE_TOKEN>
 * - If EXTRANET_WRITE_TOKEN is unset, ALL writes are blocked.
 */
export function requireWriteToken(req: Request, res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  const expected = process.env.EXTRANET_WRITE_TOKEN || "";
  const header = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/.exec(String(header));
  const token = m ? m[1] : "";

  if (expected && token === expected) return next();
  return res.status(401).json({ error: "Write operations require a Bearer token." });
}
