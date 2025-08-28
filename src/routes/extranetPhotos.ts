import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

// List (kept simple)
router.get("/", async (_req, res) => {
  try {
    const rows = await prisma.propertyPhoto.findMany({ orderBy: [{ id: "asc" }] });
    res.json(rows);
  } catch (err: any) {
    console.error("photos list error:", err);
    res.status(500).json({ error: "Failed to list photos", detail: err?.code, message: err?.message });
  }
});

// CREATE — only key & url to avoid unknown-field errors
router.post("/", async (req, res) => {
  try {
    const { key, url } = req.body ?? {};
    if (!key || !url) return res.status(400).json({ error: "key, url required" });

    const row = await prisma.propertyPhoto.create({
      data: { key, url }, // only fields we are sure exist
    });

    res.status(201).json(row);
  } catch (err: any) {
    console.error("photos create error:", err);
    res.status(500).json({ error: "Failed to create photo", detail: err?.code, message: err?.message });
  }
});

// Update
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

// Delete
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
