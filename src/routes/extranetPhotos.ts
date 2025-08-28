import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

/** GET /extranet/property/photos?partnerId=123 (partnerId optional filter) */
router.get("/", async (req, res) => {
  try {
    const partnerId = req.query.partnerId ? Number(req.query.partnerId) : undefined;
    const rows = await prisma.propertyPhoto.findMany({
      where: partnerId ? { partnerId } : undefined as any,
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
    if (!key || !url || !Number.isFinite(partnerId)) {
      return res.status(400).json({ error: "key, url, partnerId required" });
    }

    // Use relation connect — this matches your Prisma type requiring `partner`
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
$code = @'
import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

/** GET /extranet/property/photos?partnerId=123 (partnerId optional filter) */
router.get("/", async (req, res) => {
  try {
    const partnerId = req.query.partnerId ? Number(req.query.partnerId) : undefined;
    const rows = await prisma.propertyPhoto.findMany({
      where: partnerId ? { partnerId } : undefined as any,
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
    if (!key || !url || !Number.isFinite(partnerId)) {
      return res.status(400).json({ error: "key, url, partnerId required" });
    }

    // Use relation connect — this matches your Prisma type requiring `partner`
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

export default router;
