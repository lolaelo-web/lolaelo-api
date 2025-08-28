import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

/** GET /extranet/property/photos?partnerId=123 (optional filter) */
router.get("/", async (req, res) => {
  try {
    const partnerIdQ = req.query.partnerId ? Number(req.query.partnerId) : undefined;
    const rows = await prisma.propertyPhoto.findMany({
      where: partnerIdQ ? { partnerId: partnerIdQ } : undefined,
      orderBy: [{ id: "asc" }],
    });
    res.json(rows);
  } catch (err: any) {
    console.error("photos list error:", err);
    res.status(500).json({ error: "Failed to list photos", detail: err?.code, message: err?.message });
  }
});

/** POST /extranet/property/photos
 * Body required: { key, url, partnerId }
 * Optional: { alt, caption, sortOrder, isPrimary }
 */
router.post("/", async (req, res) => {
  try {
    const { key, url, partnerId, alt, caption, sortOrder, isPrimary } = req.body ?? {};
    if (!key || !url || !Number.isFinite(Number(partnerId))) {
      return res.status(400).json({ error: "key, url, partnerId required" });
    }

    const data: any = {
      key,
      url,
      partner: { connect: { id: Number(partnerId) } },
    };
    if (typeof alt !== "undefined") data.alt = alt;
    if (typeof caption !== "undefined") data.caption = caption;
    if (typeof sortOrder === "number") data.sortOrder = sortOrder;
    if (typeof isPrimary !== "undefined") data.isPrimary = Boolean(isPrimary);

    const row = await prisma.propertyPhoto.create({ data });
    res.status(201).json(row);
  } catch (err: any) {
    console.error("photos create error:", err);
    res.status(500).json({ error: "Failed to create photo", detail: err?.code, message: err?.message });
  }
});

/** PUT /extranet/property/photos/:id */
router.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
  try {
    const row = await prisma.propertyPhoto.update({ where: { id }, data: req.body ?? {} });
    res.json(row);
  } catch (err: any) {
    console.error("photos update error:", err);
    res.status(500).json({ error: "Failed to update photo", detail: err?.code, message: err?.message });
  }
});

/** DELETE /extranet/property/photos/:id */
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

/** TEMP: quick helper to discover partner IDs (remove later) */
router.get("/partners/ids", async (_req, res) => {
  try {
    const ids = await prisma.partner.findMany({ select: { id: true }, orderBy: { id: "asc" }, take: 20 });
    res.json(ids);
  } catch (err: any) {
    console.error("partners ids error:", err);
    res.status(500).json({ error: "Failed to read partners", detail: err?.code, message: err?.message });
  }
});

export default router;
