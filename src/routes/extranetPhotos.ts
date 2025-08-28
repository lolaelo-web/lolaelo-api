import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

/**
 * GET /extranet/property/photos
 * Returns all photos (adjust filters as needed).
 */
router.get("/", async (_req, res) => {
  try {
    const rows = await prisma.propertyPhoto.findMany({
      orderBy: [{ propertyId: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    });
    res.json(rows);
  } catch (err: any) {
    console.error("photos list error:", err);
    res.status(500).json({ error: "Failed to list photos", detail: err?.code, message: err?.message });
  }
});

/**
 * POST /extranet/property/photos
 * Body: { key, url, propertyId, alt?, caption?, sortOrder?, isPrimary? }
 */
router.post("/", async (req, res) => {
  try {
    const { key, url, propertyId, alt, caption, sortOrder, isPrimary } = req.body ?? {};
    if (!key || !url || typeof propertyId !== "number") {
      return res.status(400).json({ error: "key, url, propertyId required" });
    }

    const row = await prisma.propertyPhoto.create({
      data: {
        key,
        url,
        propertyId,
        alt: alt ?? null,
        caption: caption ?? null,
        sortOrder: typeof sortOrder === "number" ? sortOrder : 0,
        isPrimary: Boolean(isPrimary),
      },
    });
    res.status(201).json(row);
  } catch (err: any) {
    console.error("photos create error:", err);
    res.status(500).json({ error: "Failed to create photo", detail: err?.code, message: err?.message });
  }
});

/**
 * PUT /extranet/property/photos/:id
 */
router.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
  try {
    const row = await prisma.propertyPhoto.update({
      where: { id },
      data: req.body ?? {},
    });
    res.json(row);
  } catch (err: any) {
    console.error("photos update error:", err);
    res.status(500).json({ error: "Failed to update photo", detail: err?.code, message: err?.message });
  }
});

/**
 * DELETE /extranet/property/photos/:id
 */
router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
  try {
    await prisma.propertyPhoto.delete({ where: { id } });
    res.status(204).end();
  } catch (err: any) {
    console.error("photos delete error:", err);
    res.status(500).json({ error: "Failed to delete photo", detail: err?.code, message: err?.message });
  }
});

export default router;
