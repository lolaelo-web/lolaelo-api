import { authPartnerFromHeader } from "../extranetAuth.js";
import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();
// [LolaElo] hard auth gate (belt-and-suspenders) — self-contained auth
router.use(async (req: any, res: any, next: any) => {
  try {
    const authHeader = req.header("authorization") || req.header("Authorization");
    const altHeader  = req.header("x-partner-token");
    let token = "";
    if (authHeader && authHeader.startsWith("Bearer ")) token = authHeader.slice("Bearer ".length).trim();
    else if (altHeader) token = String(altHeader).trim();

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const now = new Date();
    // Validate session and include partner
    const session = await prisma.extranetSession.findFirst({
      where: {
        token,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      include: { partner: true },
    });

    if (!session || !session.partner) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Attach partner onto req for downstream handlers
    req.partner = session.partner;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
});// DIAG: check table/columns/count
router.get("/diag", async (_req: Request, res: Response) => {
  try {
    const exists = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'PropertyPhoto'
       ) AS exists`
    );
    // AUTH GUARD: require a valid partner for all routes below
router.use(async (req, res, next) => {
  try {
    const partner = await authPartnerFromHeader(req) as any;
const partnerId = partner?.partnerId ?? partner?.id;
if (!partnerId) return res.status(401).json({ error: "Unauthorized" });
(req as any).partnerId = Number(partnerId);
    return next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
});const columns = await prisma.$queryRawUnsafe<{ column_name: string; data_type: string; is_nullable: string }[]>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='PropertyPhoto'
        ORDER BY ordinal_position`
    );
    const count = await prisma.$queryRawUnsafe<{ count: number }[]>(
      `SELECT COUNT(*)::int AS count FROM "PropertyPhoto"`
    );
    res.json({ tableExists: !!(exists?.[0]?.exists), count: count?.[0]?.count ?? 0, columns });
  } catch (e: any) {
    res.status(500).json({ error: "diag failure", message: e?.message, code: e?.code, meta: e?.meta });
  }
});

// LIST: ?partnerId=#
router.get("/", async (req: Request, res: Response) => {
  try {
    const partnerId = (req as any).partnerId;
    const photos = await prisma.propertyPhoto.findMany({
      where: { partnerId },
      orderBy: [{ partnerId: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    });
    res.json(photos);
  } catch (e: any) {
    res.status(500).json({ error: "Failed to list photos", message: e?.message, code: e?.code, meta: e?.meta });
  }
});

// CREATE: accepts { key, url, partnerId, alt?, sortOrder?, isCover?, isPrimary?, width?, height? }
router.post("/", async (req: Request, res: Response) => {
  try {
    const { key, url, partnerId, alt, sortOrder, isCover, isPrimary, width, height } = req.body ?? {};
    if (!key || !url || partnerId === undefined || partnerId === null) {
      return res.status(400).json({ error: "key, url, partnerId required" });
    }

    const cover =
      typeof isCover === "boolean"
        ? isCover
        : typeof isPrimary === "boolean"
        ? !!isPrimary
        : false;

    const data = {
      key: String(key),
      url: String(url),
      partnerId: Number(partnerId),
      alt: typeof alt === "string" ? alt : null,
      sortOrder: typeof sortOrder === "number" ? sortOrder : 0,
      isCover: cover,
      width: typeof width === "number" ? width : null,
      height: typeof height === "number" ? height : null,
    };

    const created = await prisma.propertyPhoto.create({ data: data as any });
    return res.status(201).json(created);
  } catch (e: any) {
    console.error("photos create error:", e);
    res.status(500).json({ error: "Failed to create photo", message: e?.message, code: e?.code, meta: e?.meta });
  }
});

// UPDATE: accepts same fields; maps isPrimary -> isCover if provided
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { alt, sortOrder, isCover, isPrimary, url, key, partnerId, width, height } = req.body ?? {};

    const data: any = {};
    if (typeof alt === "string") data.alt = alt;
    if (typeof sortOrder === "number") data.sortOrder = sortOrder;
    if (typeof url === "string") data.url = url;
    if (typeof key === "string") data.key = key;
    if (typeof partnerId === "number") data.partnerId = partnerId;
    if (typeof width === "number") data.width = width;
    if (typeof height === "number") data.height = height;
    if (typeof isCover === "boolean") data.isCover = isCover;
    else if (typeof isPrimary === "boolean") data.isCover = !!isPrimary;

    const updated = await prisma.propertyPhoto.update({ where: { id }, data });
    res.json(updated);
  } catch (e: any) {
    res.status(500).json({ error: "Failed to update photo", message: e?.message, code: e?.code, meta: e?.meta });
  }
});

// DELETE
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    await prisma.propertyPhoto.delete({ where: { id } });
    res.status(204).send();
  } catch (e: any) {
    res.status(500).json({ error: "Failed to delete photo", message: e?.message, code: e?.meta });
  }
});

export default router;







