// src/routes/property.ts
import express from "express";
import { PrismaClient } from "@prisma/client";
import { authPartnerFromHeader } from "../session.js";

const prisma = new PrismaClient();
const router = express.Router();

// All routes require a valid ExtranetSession bearer token
router.use(authPartnerFromHeader);

/**
 * Shape we return to the UI (keep fields aligned with partners_app.html)
 */
function shape(p: any, fallbackEmail = "") {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    contactEmail: p.contactEmail ?? fallbackEmail ?? null,
    phone: p.phone ?? null,
    country: p.country ?? null,
    addressLine: p.addressLine ?? null,
    city: p.city ?? null,
    description: p.description ?? null,
    createdAt: p.createdAt ?? null,
    updatedAt: p.updatedAt ?? null,
  };
}

/**
 * GET /extranet/property
 * If no PropertyProfile exists, return a minimal object (null fields) so the UI can render
 */
router.get("/", async (req: any, res) => {
  try {
    const partnerId = Number(req.partner?.id || req.partnerId);
    if (!partnerId) return res.status(401).json({ error: "Unauthorized" });

    // Try to fetch an existing profile
    const profile = await prisma.propertyProfile.findFirst({
      where: { partnerId },
      orderBy: { id: "asc" },
    });

    // Also read partner to fall back contact email / name
    const partner = await prisma.partner.findUnique({ where: { id: partnerId } });

    if (!profile) {
      // Return an empty shell; UI will show "Missing info" until saved
      return res.json(
        shape(
          {
            id: null,
            name: partner?.name ?? null,
            contactEmail: partner?.email ?? null,
            phone: null,
            country: null,
            addressLine: null,
            city: null,
            description: null,
            createdAt: null,
            updatedAt: null,
          },
          partner?.email ?? ""
        )
      );
    }

    return res.json(shape(profile, partner?.email ?? ""));
  } catch (e: any) {
    console.error("[property] GET error:", e?.message || e);
    return res.status(500).json({ error: "Internal" });
  }
});

/**
 * PUT /extranet/property  -> full upsert (replace all known fields)
 * Body: { name, contactEmail, phone, country, addressLine, city, description }
 */
router.put("/", async (req: any, res) => {
  try {
    const partnerId = Number(req.partner?.id || req.partnerId);
    if (!partnerId) return res.status(401).json({ error: "Unauthorized" });

    const {
      name = null,
      contactEmail = null,
      phone = null,
      country = null,
      addressLine = null,
      city = null,
      description = null,
    } = req.body ?? {};

    const existing = await prisma.propertyProfile.findFirst({ where: { partnerId } });

    const saved = existing
      ? await prisma.propertyProfile.update({
          where: { id: existing.id },
          data: { name, contactEmail, phone, country, addressLine, city, description, updatedAt: new Date() },
        })
      : await prisma.propertyProfile.create({
          data: { partnerId, name, contactEmail, phone, country, addressLine, city, description, createdAt: new Date(), updatedAt: new Date() },
        });

    return res.json(shape(saved));
  } catch (e: any) {
    console.error("[property] PUT error:", e?.message || e);
    return res.status(500).json({ error: "Internal" });
  }
});

/**
 * PATCH /extranet/property  -> partial update
 */
router.patch("/", async (req: any, res) => {
  try {
    const partnerId = Number(req.partner?.id || req.partnerId);
    if (!partnerId) return res.status(401).json({ error: "Unauthorized" });

    const existing = await prisma.propertyProfile.findFirst({ where: { partnerId } });
    if (!existing) {
      // If nothing exists yet, create using only provided fields
      const created = await prisma.propertyProfile.create({
        data: { partnerId, ...req.body, createdAt: new Date(), updatedAt: new Date() },
      });
      return res.json(shape(created));
    }

    const updated = await prisma.propertyProfile.update({
      where: { id: existing.id },
      data: { ...req.body, updatedAt: new Date() },
    });
    return res.json(shape(updated));
  } catch (e: any) {
    console.error("[property] PATCH error:", e?.message || e);
    return res.status(500).json({ error: "Internal" });
  }
});

export default router;
