// src/routes/extranetPhotos.ts
import express, { Request, Response, NextFunction } from "express";
import { prisma } from "../prisma.js";
import { authPartnerFromHeader } from "../extranetAuth.js";

const router = express.Router();
const MAX_COUNT = Number(process.env.PHOTOS_MAX_COUNT ?? "12");

// Use the shared auth middleware directly
const requirePartner: any = authPartnerFromHeader;

const getPartnerId = (req: any) =>
  Number(req.partner?.id ?? req.partner?.partnerId ?? req.partnerId);

// NOTE: all paths here are RELATIVE to the mount point /extranet/property/photos
// Resolve/ensure a real DB partner id for this request
async function getOrCreatePartnerId(req: any): Promise<number> {
  const pid   = getPartnerId(req);
  const email: string | null =
    req.partner?.email ?? req.partnerEmail ?? null;

  // If we have a partner row by id AND it matches the email (when provided),
  // accept that id. Otherwise fall back to the email path.
  if (Number.isFinite(pid) && pid > 0) {
    const byId = await prisma.partner.findUnique({ where: { id: Number(pid) } });
    if (byId && (!email || byId.email === email)) {
      return byId.id;
    }
  }

  if (!email) {
    const err: any = new Error("unauthorized");
    err.status = 401;
    throw err;
  }

  const byEmail = await prisma.partner.findUnique({ where: { email } });
  if (byEmail) return byEmail.id;

  const name = (req.partner?.name as string | undefined) ?? email.split("@")[0];
  const created = await prisma.partner.create({ data: { email, name } });
  return created.id;
}

// LIST (optionally filter by roomTypeId) — always returns roomTypeId
router.get("/", requirePartner, async (req: any, res: Response) => {
  const partnerId = await getOrCreatePartnerId(req);

  // Optional filter ?roomTypeId=32 or ?roomTypeId= (property-level)
  const where: any = { partnerId };
  if (Object.prototype.hasOwnProperty.call(req.query, "roomTypeId")) {
    const raw = String(req.query.roomTypeId ?? "");
    if (raw.trim() === "") {
      // explicit property-level (no room)
      where.roomTypeId = null;
    } else {
      const n = Number(raw);
      if (Number.isFinite(n)) where.roomTypeId = n;
    }
  }

  try {
    const photos = await prisma.propertyPhoto.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        partnerId: true,
        key: true,
        url: true,
        alt: true,
        sortOrder: true,
        isCover: true,
        width: true,
        height: true,
        createdAt: true,
        roomTypeId: true,
      },
    });
    return res.json(photos);
  } catch (err: any) {
    console.error("[photos.list] error", { message: err?.message, code: err?.code, meta: err?.meta });
    return res.status(400).json({
      error: "list_failed",
      message: err?.message ?? null,
      code: err?.code ?? null,
      meta: err?.meta ?? null,
    });
  }
});

// CREATE one (after uploading to S3 you POST the key+url here)
router.post("/", requirePartner, async (req: any, res: Response) => {
  const partnerId = await getOrCreatePartnerId(req);
  const {
    key,
    url,
    alt = null,
    width = null,
    height = null,
    isCover = false,
    roomTypeId = null,
  } = req.body || {};

  if (!key || !url) {
    return res.status(400).json({ error: "key and url required" });
  }

  try {
    const count = await prisma.propertyPhoto.count({ where: { partnerId } });
    if (count >= MAX_COUNT) {
      return res.status(400).json({ error: "Too many photos" });
    }

    // Build known columns; include roomTypeId if valid
    const data: any = {
      partnerId,
      key: String(key),
      url: String(url),
      sortOrder: count,
    };
    if (typeof alt !== "undefined") data.alt = alt;
    if (typeof width !== "undefined") data.width = width == null ? null : Number(width);
    if (typeof height !== "undefined") data.height = height == null ? null : Number(height);
    if (typeof isCover !== "undefined") data.isCover = !!isCover;
    if (Number.isFinite(Number(roomTypeId))) data.roomTypeId = Number(roomTypeId);

    const created = await prisma.propertyPhoto.create({ data });
    return res.json(created);
  } catch (err: any) {
    console.error("[photos.create] error", {
      message: err?.message,
      code: err?.code,
      meta: err?.meta,
    });
    return res.status(400).json({
      error: "create_failed",
      message: err?.message ?? null,
      code: err?.code ?? null,
      meta: err?.meta ?? null,
    });
  }
});

// UPDATE one
router.put("/:id", requirePartner, async (req: any, res: Response) => {
  const partnerId = await getOrCreatePartnerId(req);
  const id = Number(req.params.id || 0);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "id required" });
  }

  const row = await prisma.propertyPhoto.findUnique({ where: { id } });
  if (!row) return res.status(404).json({ error: "Not found" });
  if (row.partnerId !== partnerId) {
    return res.status(403).json({ error: "Forbidden: not your photo" });
  }

  const {
    alt,
    width,
    height,
    sortOrder,
    isCover,
    roomTypeId, // NEW
  } = req.body || {};

  const data: any = {};
  if (typeof alt !== "undefined") data.alt = alt;
  if (typeof width !== "undefined") data.width = width == null ? null : Number(width);
  if (typeof height !== "undefined") data.height = height == null ? null : Number(height);
  if (typeof sortOrder !== "undefined") data.sortOrder = Number(sortOrder) || 0;
  if (typeof isCover !== "undefined") data.isCover = !!isCover;

  // NEW: Allow assigning/unassigning to room
  if (typeof roomTypeId !== "undefined") {
    const rid = Number(roomTypeId);
    data.roomTypeId = Number.isFinite(rid) ? rid : null;
  }

  try {
    const updated = await prisma.propertyPhoto.update({
      where: { id },
      data,
    });
    res.json(updated);
  } catch (err: any) {
    console.error("[photos.update] error", {
      message: err?.message,
      code: err?.code,
      meta: err?.meta,
    });
    return res.status(400).json({
      error: "update_failed",
      message: err?.message ?? null,
      code: err?.code ?? null,
      meta: err?.meta ?? null,
    });
  }
});

router.patch("/:id", requirePartner, async (req: any, res: Response) => {
  // delegate to the PUT logic by reusing the handler payload semantics
  (req as any).method = "PUT";
  return (router as any).handle(req, res);
});

// DELETE one
router.delete("/:id", requirePartner, async (req: any, res: Response) => {
  const partnerId = await getOrCreatePartnerId(req);
  const id = Number(req.params.id || 0);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "id required" });

  const row = await prisma.propertyPhoto.findFirst({ where: { id, partnerId } });
  if (!row) return res.status(404).json({ error: "Not found" });

  await prisma.propertyPhoto.delete({ where: { id } });
  res.json({ ok: true });
});

// Optional: bulk reorder
router.post("/reorder", requirePartner, async (req: any, res: Response) => {
  const partnerId = await getOrCreatePartnerId(req);
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

