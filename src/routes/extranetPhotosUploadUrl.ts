import { Router } from "express";
import crypto from "crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  s3,
  S3_BUCKET,
  PUBLIC_BASE,
  PHOTOS_PREFIX,
  UPLOAD_TTL,
  ALLOWED_MIME,
  MAX_MB,
} from "../storage/s3.js"; // if TS complains about .js, change to "../storage/s3"

const r = Router();

/**
 * POST /extranet/property/photos/upload-url
 * Body: { fileName: string, contentType: string, size?: number }
 * Auth: Bearer token or x-partner-token (your existing middleware should set req.partner?.id or req.user?.partnerId)
 * Returns: { putUrl, publicUrl, key }
 */
r.post("/extranet/property/photos/upload-url", async (req, res) => {
  try {
    const partnerId: string | undefined =
      (req as any).partner?.id || (req as any).user?.partnerId;

    if (!partnerId) return res.status(401).json({ error: "unauthorized" });

    const { fileName, contentType, size } = req.body || {};
    if (!fileName || !contentType) {
      return res.status(400).json({ error: "fileName and contentType required" });
    }
    if (!ALLOWED_MIME.includes(contentType)) {
      return res.status(400).json({ error: "mime_not_allowed" });
    }
    if (size && size > MAX_MB * 1024 * 1024) {
      return res.status(400).json({ error: `max_${MAX_MB}MB` });
    }

    const ext = (fileName.split(".").pop() || "jpg").toLowerCase();
    const keyPrefix = `${PHOTOS_PREFIX}${partnerId}/`;
    const key = `${keyPrefix}${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${ext}`;

    const putCmd = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      ContentType: contentType,
      ...(process.env.S3_OBJECT_ACL ? { ACL: process.env.S3_OBJECT_ACL as any } : {}),
    });

    const putUrl = await getSignedUrl(s3, putCmd, { expiresIn: UPLOAD_TTL });
    const publicUrl = `${PUBLIC_BASE}/${key}`;

    return res.json({ putUrl, publicUrl, key });
  } catch (err) {
    console.error("upload-url error", err);
    return res.status(500).json({ error: "upload_url_failed" });
  }
});

export default r;
