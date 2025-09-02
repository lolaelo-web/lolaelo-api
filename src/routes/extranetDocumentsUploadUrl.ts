import { Router } from "express";
import crypto from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const router = Router();

const S3_BUCKET = process.env.S3_BUCKET ?? "";
const S3_REGION = process.env.S3_REGION ?? process.env.AWS_REGION ?? "us-east-1";
const PUB_BASE  = process.env.S3_PUBLIC_BASE_URL ?? (S3_REGION === "us-east-1"
  ? `https://${S3_BUCKET}.s3.amazonaws.com`
  : `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com`);
// Documents config (separate from photos)
const MAX_MB = Number(process.env.DOCS_MAX_MB ?? 10);
const ALLOWED = (process.env.DOCS_ALLOWED_MIME ??
  "application/pdf,image/jpeg,image/png,image/webp,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/zip"
).split(",").map(s => s.trim().toLowerCase());
const PREFIX = process.env.DOCS_PREFIX ?? "docs";

const DRYRUN    = (process.env.UPLOAD_DRYRUN ?? "0") === "1";

const s3 = new S3Client({
  region: S3_REGION,
  credentials:
    process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
      ? { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! }
      : undefined,
});

router.post("/", async (req, res) => {
  try {
    const { fileName, contentType, size } = req.body ?? {};
    if (!fileName || !contentType || typeof size !== "number") {
      return res.status(400).json({ error: "fileName, contentType, size required" });
    }

    const ct = String(contentType).toLowerCase();
    if (!ALLOWED.includes(ct)) return res.status(400).json({ error: "Unsupported contentType", allowed: ALLOWED });
    if (size > MAX_MB * 1024 * 1024) return res.status(400).json({ error: "File too large", maxMB: MAX_MB });

    const ext = fileName.includes(".") ? String(fileName).split(".").pop() : "bin";
    const key = `${PREFIX}/${crypto.randomUUID()}.${ext}`;

    if (DRYRUN) {
      const putUrl = `https://example.invalid/put/${encodeURIComponent(key)}`;
      const publicUrl = `${PUB_BASE}/${key}`;
      return res.json({ putUrl, publicUrl, key, dryRun: true });
    }

    if (!S3_BUCKET) return res.status(500).json({ error: "Missing S3_BUCKET" });

    const cmd = new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, ContentType: ct });
    const putUrl = await getSignedUrl(s3, cmd, { expiresIn: 60 });
    const publicUrl = `${PUB_BASE}/${key}`;
    return res.json({ putUrl, publicUrl, key });
  } catch (err: any) {
    console.error("upload-url error:", err);
    return res.status(500).json({
      error: "Failed to create upload URL",
      detail: err?.name || "AWS",
      message: err?.message || String(err),
    });
  }
});

// env diag (no secrets)
router.get("/diag", (_req, res) => {
  res.json({
    dryRun: (process.env.UPLOAD_DRYRUN ?? "0") === "1",
    bucket: process.env.S3_BUCKET || null,
    region: process.env.S3_REGION ?? process.env.AWS_REGION ?? null,
    pubBase: process.env.S3_PUBLIC_BASE_URL || null
  });
});

export default router;
