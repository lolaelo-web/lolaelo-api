import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { authPartnerFromHeader } from "../extranetAuth.js";

const prisma = new PrismaClient();
const router = Router();

/** Allowed enums (must match prisma/schema.prisma) */
const ALLOWED_TYPES = [
  "GOVT_ID",
  "BUSINESS_REG",
  "TAX_ID",
  "BANK_PROOF",
  "PROOF_OF_ADDRESS",
  "INSURANCE_LIABILITY",
  "PROPERTY_OWNERSHIP",
  "LOCAL_LICENSE",
] as const;
type DocType = (typeof ALLOWED_TYPES)[number];

const ALLOWED_STATUS = ["REQUIRED", "SUBMITTED", "APPROVED", "REJECTED"] as const;
type DocStatus = (typeof ALLOWED_STATUS)[number];

/** Require auth for everything in this router */
router.use(authPartnerFromHeader);

/** Guard: ensure req.user exists and stash partnerId to avoid crashes */
router.use((req: any, res, next) => {
  const u = req?.user;
  if (!u || !u.partnerId) return res.status(401).json({ error: "unauthorized" });
  req.partnerId = u.partnerId;
  next();
});

/** GET /extranet/property/documents */
router.get("/", async (req: any, res) => {
  const partnerId = req.partnerId as number;
  const rows = await prisma.propertyDocument.findMany({
    where: { partnerId },
    orderBy: [{ type: "asc" }, { uploadedAt: "desc" }],
  });
  return res.json(rows);
});

/** POST /extranet/property/documents
 *  body: { type, key, url, fileName?, contentType? }
 */
router.post("/", async (req: any, res) => {
  try {
    const partnerId = req.partnerId as number;
    let { type, key, url, fileName, contentType } = req.body || {};

    if (!type || !key || !url) {
      return res.status(400).json({ error: "type, key and url are required" });
    }

    // coerce/validate type
    const up = String(type).toUpperCase();
    if (!ALLOWED_TYPES.includes(up as DocType)) {
      return res.status(400).json({ error: "invalid_document_type" });
    }
    type = up;

    // one-per-type per partner (compound unique in schema)
    const row = await prisma.propertyDocument.upsert({
      where: { partnerId_type: { partnerId, type } },
      update: {
        key,
        url,
        fileName,
        contentType,
        status: "SUBMITTED",
        uploadedAt: new Date(),
        notes: null,
      },
      create: {
        partnerId,
        type,
        key,
        url,
        fileName,
        contentType,
        status: "SUBMITTED",
      },
    });

    return res.json(row);
  } catch (e: any) {
    console.error("create document error:", e);
    return res.status(400).json({ error: "create_failed" });
  }
});

/** PUT /extranet/property/documents/:id
 *  body: { status?, notes?, expiresAt?, type? }
 */
router.put("/:id", async (req: any, res) => {
  const partnerId = req.partnerId as number;
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "bad_id" });

  let { status, notes, expiresAt, type } = req.body || {};

  if (status) {
    const upStatus = String(status).toUpperCase();
    if (!ALLOWED_STATUS.includes(upStatus as DocStatus)) {
      return res.status(400).json({ error: "invalid_status" });
    }
    status = upStatus;
  }

  if (type) {
    const upType = String(type).toUpperCase();
    if (!ALLOWED_TYPES.includes(upType as DocType)) {
      return res.status(400).json({ error: "invalid_type" });
    }
    type = upType;
  }

  // ownership check
  const existing = await prisma.propertyDocument.findFirst({ where: { id, partnerId } });
  if (!existing) return res.status(404).json({ error: "not_found" });

  try {
    const updated = await prisma.propertyDocument.update({
      where: { id },
      data: {
        status: (status as DocStatus) || undefined,
        notes: typeof notes === "string" ? notes : undefined,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        type: (type as DocType) || undefined,
        verifiedAt: status === "APPROVED" ? new Date() : undefined,
      },
    });
    return res.json(updated);
  } catch (e: any) {
    console.error("update document error:", e);
    return res.status(400).json({ error: "update_failed" });
  }
});

/** DELETE /extranet/property/documents/:id */
router.delete("/:id", async (req: any, res) => {
  const partnerId = req.partnerId as number;
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "bad_id" });

  const existing = await prisma.propertyDocument.findFirst({ where: { id, partnerId } });
  if (!existing) return res.status(404).json({ error: "not_found" });

  await prisma.propertyDocument.delete({ where: { id } });
  return res.status(204).end();
});

export default router;
