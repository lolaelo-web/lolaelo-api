// src/server.ts
import express from "express";
import cors from "cors";
import path from "path";

import extranetPhotos       from "./routes/extranetPhotos.js";
import photosUploadUrl      from "./routes/extranetPhotosUploadUrl.js";
import extranetAuth         from "./routes/extranetAuth.js";
import extranetDocuments    from "./routes/extranetDocuments.js";
import documentsUploadUrl   from "./routes/extranetDocumentsUploadUrl.js";
import extranetRooms        from "./routes/extranetRooms.js";

const app = express();
// Disable etag for API responses (prevents conditional GET -> 304)
app.set("etag", false);

// Force no-store on all /extranet/* endpoints
app.use("/extranet", (_req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  next();
});
/* --------- STATIC: serve /public at both / and /public ---------- */
const pubPath = path.resolve(process.cwd(), "public");

// /partners_rooms.html, /js/shared.js, etc.
app.use(express.static(pubPath, { extensions: ["html"], maxAge: "1h", etag: true }));
// also allow /public/partners_rooms.html, /public/js/shared.js
app.use("/public", express.static(pubPath, { extensions: ["html"], maxAge: "1h", etag: true }));

// belt & suspenders: explicit route for shared.js
app.get("/js/shared.js", (_req, res) => {
  res.sendFile(path.join(pubPath, "js", "shared.js"));
});

/* -------------------- Parse + CORS -------------------- */
app.set("trust proxy", 1);
app.use(express.json({ limit: "10mb" }));

const ALLOWED_ORIGINS = [
  "https://lolaelo.com",
  "https://www.lolaelo.com",
  "https://lolaelo-web.github.io",
  // "http://localhost:5173",
  // "http://127.0.0.1:5173",
];
app.use(
  cors({
    origin: (origin, cb) => (!origin || ALLOWED_ORIGINS.includes(origin)) ? cb(null, true) : cb(null, false),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-partner-token", "Accept"],
  })
);
app.options("*", cors({
  origin: (origin, cb) => (!origin || ALLOWED_ORIGINS.includes(origin)) ? cb(null, true) : cb(null, false),
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-partner-token", "Accept"],
  maxAge: 86400,
}));

/* ---------------------- Health ----------------------- */
app.get("/health", (_req, res) => res.status(200).send("OK v-AUTH-2"));

/* ---------------------- Routes ----------------------- */
app.use("/extranet/property/photos/upload-url", photosUploadUrl);
app.use("/extranet/property/photos", extranetPhotos);
app.use("/extranet/property/documents/upload-url", documentsUploadUrl);
app.use("/extranet/property/documents", extranetDocuments);
app.use("/extranet/property/rooms", extranetRooms);
app.use(extranetAuth);

/* -------------------- Diagnostics -------------------- */
app.get("/__routes", (req, res) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stack = (req.app as any)?._router?.stack ?? [];
  const routes = stack.filter((l: any) => l.route)
    .map((l: any) => ({ path: l.route.path, methods: Object.keys(l.route.methods) }));
  res.json({ routes });
});

/* ------------------ 404 / 500 ------------------ */
app.use((req, res) => res.status(404).json({ error: "Not Found", path: req.path }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal Server Error" });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));

export default app;
