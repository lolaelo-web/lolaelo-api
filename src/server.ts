import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import { execFile } from "child_process";
import util from "util";

// ESM runtime needs .js suffix after TS compiles
import extranetPhotos from "./routes/extranetPhotos.js";
import photosUploadUrl from "./routes/extranetPhotosUploadUrl.js";

const app = express();
const prisma = new PrismaClient();
const execFileP = util.promisify(execFile);

// ---------- ONE-TIME BOOTSTRAP (remove after success) --------------------
async function ensurePropertyPhoto() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "PropertyPhoto" (
      "id" SERIAL PRIMARY KEY,
      "key" TEXT NOT NULL,
      "url" TEXT NOT NULL,
      "partnerId" INTEGER NOT NULL,
      "alt" TEXT,
      "caption" TEXT,
      "sortOrder" INTEGER DEFAULT 0,
      "isPrimary" BOOLEAN DEFAULT FALSE,
      "createdAt" TIMESTAMPTZ DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS "PropertyPhoto_partnerId_idx" ON "PropertyPhoto" ("partnerId");
  `);
}
ensurePropertyPhoto().catch(e => console.error("ensurePropertyPhoto error:", e));
// ------------------------------------------------------------------------

// Parse + CORS
app.set("trust proxy", 1);
app.use(express.json({ limit: "10mb" }));
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://lolaelo.com",
  "https://www.lolaelo.com",
];
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-partner-token"],
  })
);

// Health fingerprint
app.get("/health", (_req, res) => res.status(200).send("OK v-UPLOAD-2"));

// Mount routers
app.use("/extranet/property/photos/upload-url", photosUploadUrl);
app.use("/extranet/property/photos", extranetPhotos);

// ----- TEMP ADMIN: run Prisma db push on Render (optional; before 404) ----
app.post("/__admin/db-push", async (req, res) => {
  try {
    if (req.header("x-admin-key") !== process.env.ADMIN_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { stdout, stderr } = await execFileP("npx", ["prisma", "db", "push", "--skip-generate"], {
      env: process.env,
      timeout: 120_000,
    });
    res.json({ ok: true, stdout, stderr });
  } catch (e: any) {
    res.status(500).json({
      ok: false,
      message: e?.message,
      stdout: e?.stdout?.toString(),
      stderr: e?.stderr?.toString(),
    });
  }
});
// --------------------------------------------------------------------------

// Diagnostics
app.get("/__routes", (req, res) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stack = (req.app as any)?._router?.stack ?? [];
  const routes = stack
    .filter((l: any) => l.route)
    .map((l: any) => ({ path: l.route.path, methods: Object.keys(l.route.methods) }));
  res.json({ routes });
});

// 404 after all routes
app.use((req, res) => res.status(404).json({ error: "Not Found", path: req.path }));

// Error handler
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal Server Error" });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});

export default app;
