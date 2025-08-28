import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

// DIAG: check table/columns/count
router.get("/diag", async (_req: Request, res: Response) => {
  try {
    const exists = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'PropertyPhoto'
       ) AS exists`
    );
    const columns = await prisma.$queryRawUnsafe<{ column_name: string; data_type: string; is_nullable: string }[]>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='PropertyPhoto'
        ORDER BY ordinal_position`
    );
    const count = await prisma.$queryRawUnsafe<{ count: number }[]>(
      `SELECT COUNT(*)::int AS count FROM "PropertyPhoto"`
    );
    res.json({
      tableExists: !!(exists?.[0]?.exists),
      count: count?.[0]?.count ?? 0,
      columns,
    });
  } catch (e: any) {
    res.status(500).json({ error: "diag failure", message: e?.message, code: e?.code, meta: e?.meta });
  }
});

// LIST: ?partnerId=#
router.get("/", async (req: Request, res: Response) => {
  try {
    const partnerId = req.query.partnerId ? Number(req.query.partnerId) : undefined;
    const photos = await prisma.propertyPhoto.findMany({
      where: partnerId ? { partnerId } : {},
      orderBy: [{ partnerId: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    });
    res.json(photos);
  } catch (e: any) {
    res.status(500).json({ error: "Failed to list photos", message: e?.message, code: e?.code, meta: e?.meta });
  }
});

// CREATE: expects { key, url, partnerId, alt?, sortOrder?, isPrimary? }
router.post("/", async (req: Request, res: Response) => {
  try {
    const { key, url, partnerId, alt, sortOrder, isPrimary } = req.body ?? {};
    if (!key || !url || partnerId === undefined || partnerId === null) {
      return res.status(400).json({ error: "key, url, partnerId required" });
    }

    const data = {
      key: String(key),
      url: String(url),
      partnerId: Number(partnerId),
      alt: typeof alt === "string" ? alt : null,
      sortOrder: typeof sortOrder === "number" ? sortOrder : 0,
      isPrimary: !!isPrimary,
    };

    const created = await prisma.propertyPhoto.create({ data: data as any });
    return res.status(201).json(created);
  } catch (e: any) {
    console.error("photos create error:", e);
    res.status(500).json({ error: "Failed to create photo", message: e?.message, code: e?.code, meta: e?.meta });
  }
});

// UPDATE
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { alt, sortOrder, isPrimary, url, key, partnerId } = req.body ?? {};
    const updated = await prisma.propertyPhoto.update({
      where: { id },
      data: {
        alt: typeof alt === "string" ? alt : undefined,
        sortOrder: typeof sortOrder === "number" ? sortOrder : undefined,
        isPrimary: typeof isPrimary === "boolean" ? isPrimary : undefined,
        url: typeof url === "string" ? url : undefined,
        key: typeof key === "string" ? key : undefined,
        partnerId: typeof partnerId === "number" ? partnerId : undefined,
      } as any,
    });
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
    res.status(500).json({ error: "Failed to delete photo", message: e?.message, code: e?.code, meta: e?.meta });
  }
});

export default router;
