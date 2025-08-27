// src/routes/extranetPhotos.ts
import express from "express";
import { prisma } from "../prisma.js";
import { authPartnerFromHeader } from "../extranetAuth.js";

type AuthedReq = express.Request & {
  partner?: { id: number; email: string | null; name?: string | null };
};

const router = express.Router();

async function requirePartner(
  req: AuthedReq,
  res: express.Response,
  next: express.NextFunction
) {
  try {
    const partner = await authPartnerFromHeader(req as any);
    if (!partner) return res.status(401).json({ error: "Unauthorized" });
    req.partner = partner as any;
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
}

router.get("/", requirePartner, async (req: AuthedReq, res) => {
  const partnerId = req.partner!.id;
  const photos = await prisma.propertyPhoto.findMany({
    where: { partnerId },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
  res.json(photos);
});

router.post("/", requirePartner, async (req: AuthedReq, res) => {
  const partnerId = req.partner!.id;
  const {
    key,
    url,
    publicUrl,
    alt = null,
    sortOrder,
    isCover = false,
    width = null,
    height = null,
  } = req.body || {};

  const finalUrl = typeof publicUrl === "string" ? publicUrl : url;
  if (!key || typeof key !== "string") return res.status(400).json({ error: "key is required" });
  if (!finalUrl || typeof finalUrl !== "string") return res.status(400).json({ error: "url/publicUrl is required" });

  const maxOrder = await prisma.propertyPhoto.aggregate({
    where: { partnerId },
    _max: { sortOrder: true },
  });
  const order =
    typeof sortOrder === "number" && Number.isFinite(sortOrder)
      ? sortOrder
      : (maxOrder._max.sortOrder ?? -1) + 1;

  const tx: any[] = [];
  if (isCover) {
    tx.push(
      prisma.propertyPhoto.updateMany({
        where: { partnerId, isCover: true },
        data: { isCover: false },
      })
    );
  }

  tx.push(
    prisma.propertyPhoto.create({
      data: {
        partnerId,
        key,
        url: finalUrl,
        alt,
        sortOrder: order,
        isCover: !!isCover,
        width: typeof width === "number" ? width : null,
        height: typeof height === "number" ? height : null,
      },
    })
  );

  const [, created] = await prisma.$transaction(tx);
  res.status(201).json(created);
});

router.patch("/:id", requirePartner, async (req: AuthedReq, res) => {
  const partnerId = req.partner!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });

  const { alt, isCover, sortOrder } = req.body || {};
  const data: any = {};
  if (typeof alt === "string" || alt === null) data.alt = alt;
  if (typeof sortOrder === "number") data.sortOrder = sortOrder;

  if (isCover === true) {
    await prisma.$transaction([
      prisma.propertyPhoto.updateMany({
        where: { partnerId, isCover: true },
        data: { isCover: false },
      }),
      prisma.propertyPhoto.update({
        where: { id },
        data: { ...data, isCover: true },
      }),
    ]);
    const updated = await prisma.propertyPhoto.findUnique({ where: { id } });
    return res.json(updated);
  }

  if (isCover === false) data.isCover = false;

  const updated = await prisma.propertyPhoto.update({
    where: { id },
    data,
  });
  res.json(updated);
});

router.delete("/:id", requirePartner, async (req: AuthedReq, res) => {
  const partnerId = req.partner!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });

  const photo = await prisma.propertyPhoto.findUnique({ where: { id } });
  if (!photo || photo.partnerId !== partnerId) {
    return res.status(404).json({ error: "Not found" });
  }

  await prisma.propertyPhoto.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
