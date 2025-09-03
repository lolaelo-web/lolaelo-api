import express from "express";
import cors from "cors";

// ESM runtime needs .js in import paths after TS compiles to dist/
import extranetPhotos from "./routes/extranetPhotos.js";
import photosUploadUrl from "./routes/extranetPhotosUploadUrl.js";
import extranetAuth from "./routes/extranetAuth.js";

import extranetDocuments from "./routes/extranetDocuments.js";
import documentsUploadUrl from "./routes/extranetDocumentsUploadUrl.js";

// NEW: Rooms & Availability router
import extranetRooms from "./routes/extranetRooms.js";

import path from "path";
import express from "express";

const pubPath = path.join(__dirname, "..", "public");
app.use(express.static(pubPath, { maxAge: "1h", etag: true }));          // serves /js/shared.js
app.use("/public", express.static(pubPath, { maxAge: "1h", etag: true })); // also serves /public/js/shared.js

const app = express();

//
// [APPTAP-BEGIN]
app.all("/extranet/property/photos/__apptap/:id?", express.json(), (req, res) => {
  return res.status(200).json({
    ok: true,
    where: "app-tap",
    method: req.method,
    path: req.originalUrl,
    id: req.params?.id ?? null,
    body: req.body ?? null
  });
});
// [APPTAP-END]

// Parse + CORS
app.set("trust proxy", 1);
app.use(express.json({ limit: "10mb" }));
app.use(express.static("public", { extensions: ["html"] }));

const ALLOWED_ORIGINS = [
  "https://lolaelo.com",
  "https://www.lolaelo.com",
  "https://lolaelo-web.github.io",
  // add dev origins temporarily only if you need them:
  // "http://localhost:5173",
  // "http://127.0.0.1:5173",
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-partner-token"],
  })
);

app.options(
  "*",
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-partner-token", "Accept"],
    maxAge: 86400,
  })
);

// Health (fingerprint)
app.get("/health", (_req, res) => res.status(200).send("OK v-AUTH-2"));

// Mount routers
app.use("/extranet/property/photos/upload-url", photosUploadUrl);
app.use("/extranet/property/photos", extranetPhotos);

app.use("/extranet/property/documents/upload-url", documentsUploadUrl);
app.use("/extranet/property/documents", extranetDocuments);

// NEW: Rooms & Availability endpoints
app.use("/extranet/property/rooms", extranetRooms);

app.use(extranetAuth);

// Diagnostics: list registered routes
app.get("/__routes", (req, res) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stack = (req.app as any)?._router?.stack ?? [];
  const routes = stack
    .filter((l: any) => l.route)
    .map((l: any) => ({ path: l.route.path, methods: Object.keys(l.route.methods) }));
  res.json({ routes });
});

// 404
app.use((req, res) => res.status(404).json({ error: "Not Found", path: req.path }));

// Error handler
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal Server Error" });
});

const PORT = Number(process.env.PORT || 3000);

//
// [APP-ERR-LOGGER-BEGIN]
app.use((err: any, req: any, res: any, _next: any) => {
  try {
    console.error("[APP ERROR]", {
      message: err?.message,
      name: err?.name,
      code: err?.code,
      stack: err?.stack,
      path: req?.originalUrl,
      method: req?.method,
    });
  } catch {}
  return res.status(500).json({
    error: "Internal Server Error",
    where: "app",
    message: err?.message ?? null,
    code: err?.code ?? null,
  });
});
// [APP-ERR-LOGGER-END]

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});

export default app;
