import express from "express";
import { authPartnerFromHeader } from "../extranetAuth.js";
import crypto from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const router = express.Router();

const ALLOWED = (process.env.PHOTOS_ALLOWED_MIME ?? "image/jpeg,image/png,image/webp")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const MAX_MB = Number(process.env.PHOTOS_MAX_MB ?? "5");
const MAX_BYTES = MAX_MB * 1024 * 1024;

const s3 = new S3Client({
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
  },
});
const BUCKET = process.env.AWS_S3_BUCKET ?? "";

async function requirePartner(req: any, res: any, next: any) {
  const partner = await authPartnerFromHeader(req).catch(() => null);
  if (!partner) return res.status(401).json({ error: "Unauthorized" });
  req.partner = partner;
  next();
}

// NOTE: this router is mounted at /extranet/property/photos/upload-url
router.post("/", requirePartner, async (req: any, res) => {
  const { fileName, contentType, size } = req.body || {};
  if (!fileName || !contentType || typeof size !== "number") {
    return res.status(400).json({ error: "fileName, contentType, size required" });
  }
  if (!ALLOWED.includes(contentType)) {
    return res.status(400).json({ error: `type not allowed; allowed: ${ALLOWED.join(", ")}` });
  }
  if (size > MAX_BYTES) {
    return res.status(400).json({ error: `file too large; max ${MAX_MB}MB` });
  }

  const key = `partners/${req.partner.id}/${Date.now()}_${crypto.randomBytes(6).toString("hex")}_${fileName}`;
  const putCmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });
  const putUrl = await getSignedUrl(s3, putCmd, { expiresIn: 60 });

  const publicUrl = `https://${BUCKET}.s3.amazonaws.com/${encodeURIComponent(key)}`;
  res.json({ putUrl, publicUrl, key });
});

export default router;
