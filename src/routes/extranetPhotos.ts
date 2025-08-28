import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

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
    console.error("photos list error:", e);
    res.status(500).json({ error: "Failed to list photos" });
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

    // Use unchecked shape to avoid relation typing constraints.
    const created = await prisma.propertyPhoto.create({ data: data as any });
    return res.status(201).json(created);
  } catch (e: any) {
    console.error("photos create error:", e);
    if (e?.code) {
      return res.status(400).json({ error: "PrismaError", code: e.code, message: e?.meta?.cause ?? e.message });
    }
    res.status(500).json({ error: "Failed to create photo" });
  }
});

// UPDATE (no caption field in schema)
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
    console.error("photos update error:", e);
    res.status(500).json({ error: "Failed to update photo" });
  }
});

// DELETE
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    await prisma.propertyPhoto.delete({ where: { id } });
    res.status(204).send();
  } catch (e: any) {
    console.error("photos delete error:", e);
    res.status(500).json({ error: "Failed to delete photo" });
  }
});

export default router;
