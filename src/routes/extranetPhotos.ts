// src/routes/extranetPhotos.ts
import express from "express";
import { prisma } from "../prisma.js";
import { authPartnerFromHeader } from "../extranetAuth.js";

const router = express.Router();
const MAX_COUNT = Number(process.env.PHOTOS_MAX_COUNT ?? "12");

// Auth helper
async function requirePartner(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const p = await authPartnerFromHeader(req as any);
  if (!p) return res.status(401).json({ error: "Unauthorized" });
  // @ts-ignore
  req.partner = p;
  next();
}

/**
 * GET list photos for current partner
 */
router.get("/extranet/property/photos", requirePartner, async (req, res) => {
  // @ts-ignore
  const partnerId = req.partner.id as number;
  const rows = await prisma.propertyPhoto.findMany({
    where: { partnerId },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
  res.json(rows);
});

/**
 * POST create a photo record after successful S3 upload
 * Body: { key, url, fileName?, alt?, width?, height?, isCover?, sortOrder? }
 */
router.post("/extranet/property/photos", requirePartner, async (req, res) => {
  // @ts-ignore
  const partnerId = req.partner.id as number;
  const {
    key,
    url,
    fileName = null,
    alt = null,
    width = null,
    height = null,
    isCover = false,
    sortOrder = null,
  } = req.body || {};

  if (!key || !url) return res.status(400).json({ error: "key and url required" });

  const count = await prisma.propertyPhoto.count({ where: { partnerId } });
  if (count >= MAX_COUNT) {
    return res.status(400).json({ error: `Max ${MAX_COUNT} photos reached` });
  }

  const so =
    typeof sortOrder === "number" && Number.isFinite(sortOrder) ? sortOrder : count;

  const created = await prisma.$transaction(async (tx) => {
    if (isCover) {
      await tx.propertyPhoto.updateMany({
        where: { partnerId, isCover: true },
        data: { isCover: false },
      });
    }
    return tx.propertyPhoto.create({
      data: {
        partnerId,
        key,
        url,
        alt,
        sortOrder: so,
        isCover: !!isCover,
        width: width ?? null,
        height: height ?? null,
      },
    });
  });

  res.status(201).json(created);
});

/**
 * PUT update metadata (alt, sortOrder, isCover)
 */
router.put("/extranet/property/photos/:id", requirePartner, async (req, res) => {
  // @ts-ignore
  const partnerId = req.partner.id as number;
  const id = Number(req.params.id);
  const { alt, sortOrder, isCover } = req.body || {};

  const existing = await prisma.propertyPhoto.findUnique({ where: { id } });
  if (!existing || existing.partnerId !== partnerId) {
    return res.status(404).json({ error: "Not found" });
  }

  const data: any = {};
  if (typeof alt === "string") data.alt = alt;
  if (typeof sortOrder === "number" && Number.isFinite(sortOrder)) {
    data.sortOrder = sortOrder;
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (isCover === true) {
      await tx.propertyPhoto.updateMany({
        where: { partnerId, isCover: true },
        data: { isCover: false },
      });
      data.isCover = true;
    } else if (isCover === false) {
      data.isCover = false;
    }
    return tx.propertyPhoto.update({ where: { id }, data });
  });

  res.json(updated);
});

/**
 * DELETE a photo record (does NOT delete S3 object by default)
 */
router.delete("/extranet/property/photos/:id", requirePartner, async (req, res) => {
  // @ts-ignore
  const partnerId = req.partner.id as number;
  const id = Number(req.params.id);

  const photo = await prisma.propertyPhoto.findUnique({ where: { id } });
  if (!photo || photo.partnerId !== partnerId) {
    return res.status(404).json({ error: "Not found" });
  }

  await prisma.propertyPhoto.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
