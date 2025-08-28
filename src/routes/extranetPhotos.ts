// src/routes/extranetPhotos.ts
import express, { Request, Response, NextFunction } from "express";
import { prisma } from "../prisma.js";
import { authPartnerFromHeader } from "../extranetAuth.js";

const router = express.Router();
const MAX_COUNT = Number(process.env.PHOTOS_MAX_COUNT ?? "12");

// Require partner auth
async function requirePartner(req: any, res: Response, next: NextFunction) {
  try {
    const partner = await authPartnerFromHeader(req);
    if (!partner) return res.status(401).json({ error: "Unauthorized" });
    req.partner = partner;
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

const getPartnerId = (req: any) =>
  Number(req.partner?.id ?? req.partner?.partnerId ?? req.partnerId);

// NOTE: all paths here are RELATIVE to the mount point /extranet/property/photos

// GET list
router.get("/", requirePartner, async (req: any, res: Response) => {
  const partnerId = getPartnerId(req);
  const photos = await prisma.propertyPhoto.findMany({
    where: { partnerId },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
  res.json(photos);
});

// CREATE one (after uploading to S3 you POST the key+url here)
router.post("/", requirePartner, async (req: any, res: Response) => {
  const partnerId = getPartnerId(req);
  const { key, url, alt = null, width = null, height = null, isCover = false } = req.body || {};
  if (!key || !url) return res.status(400).json({ error: "key and url required" });

  const count = await prisma.propertyPhoto.count({ where: { partnerId } });
  if (count >= MAX_COUNT) return res.status(400).json({ error: "Too many photos" });

  const created = await prisma.propertyPhoto.create({
    data: {
      partnerId,
      key: String(key),
      url: String(url),
      alt,
      width: width == null ? null : Number(width),
      height: height == null ? null : Number(height),
      isCover: !!isCover,
      sortOrder: count,
    },
  });
  res.json(created);
});

// UPDATE one
router.put("/:id", requirePartner, async (req: any, res: Response) => {
  const partnerId = getPartnerId(req);
  const id = Number(req.params.id || 0);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "id required" });

  const row = await prisma.propertyPhoto.findUnique({ where: { id } });
  if (!row) return res.status(404).json({ error: "Not found" });
  if (row.partnerId !== partnerId) return res.status(403).json({ error: "Forbidden: not your photo" });

  const { alt, width, height, sortOrder, isCover } = req.body || {};
  const data: any = {};
  if (typeof alt !== "undefined") data.alt = alt;
  if (typeof width !== "undefined") data.width = width == null ? null : Number(width);
  if (typeof height !== "undefined") data.height = height == null ? null : Number(height);
  if (typeof sortOrder !== "undefined") data.sortOrder = Number(sortOrder) || 0;
  if (typeof isCover !== "undefined") data.isCover = !!isCover;

  const updated = await prisma.propertyPhoto.update({ where: { id }, data });
  res.json(updated);
});

// DELETE one
router.delete("/:id", requirePartner, async (req: any, res: Response) => {
  const partnerId = getPartnerId(req);
  const id = Number(req.params.id || 0);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "id required" });

  const row = await prisma.propertyPhoto.findFirst({ where: { id, partnerId } });
  if (!row) return res.status(404).json({ error: "Not found" });

  await prisma.propertyPhoto.delete({ where: { id } });
  res.json({ ok: true });
});

// Optional: bulk reorder
router.post("/reorder", requirePartner, async (req: any, res: Response) => {
  const partnerId = getPartnerId(req);
  const items: Array<{ id: number; sortOrder: number }> = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "no_items" });

  const ids = items.map((i) => Number(i.id)).filter((n) => Number.isFinite(n));
  const records = await prisma.propertyPhoto.findMany({ where: { id: { in: ids } } });
  if (records.some((r) => r.partnerId !== partnerId)) return res.status(403).json({ error: "forbidden_some_items" });

  await prisma.$transaction(
    items.map((i) =>
      prisma.propertyPhoto.update({
        where: { id: Number(i.id) },
        data: { sortOrder: Number(i.sortOrder) },
      })
    )
  );
  res.json({ ok: true });
});

export default router;
