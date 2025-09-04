import { S3Client } from "@aws-sdk/client-s3";
const region = process.env.S3_REGION;
const credentials = {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
};
export const s3 = new S3Client({
    region,
    credentials,
    ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
    ...(process.env.S3_FORCE_PATH_STYLE === "true" ? { forcePathStyle: true } : {}),
});
export const S3_BUCKET = process.env.S3_BUCKET;
export const PUBLIC_BASE = process.env.S3_PUBLIC_BASE_URL;
export const PHOTOS_PREFIX = process.env.PHOTOS_PREFIX || "photos/";
export const UPLOAD_TTL = Number(process.env.EXTRANET_PHOTOS_UPLOAD_TTL_SECONDS || "900");
export const ALLOWED_MIME = (process.env.PHOTOS_ALLOWED_MIME || "image/jpeg,image/png,image/webp").split(",");
export const MAX_MB = Number(process.env.PHOTOS_MAX_MB || "5");
