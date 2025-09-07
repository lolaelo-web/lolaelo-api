// src/server.ts
// ESM-friendly Express server with strict CORS for lolaelo.com and static hosting from /public

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

// ----------------------------------------------------------------------------
// ESM __dirname
// ----------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----------------------------------------------------------------------------
const app = express();

// ----------------------------------------------------------------------------
// CORS: allow production site to call the API from the browser
// - Includes Cache-Control/Pragma in allowed headers (your frontend sets them)
// - Handles preflight globally
// ----------------------------------------------------------------------------
const CORS_ALLOWED_ORIGINS = ["https://www.lolaelo.com"]; // add more origins if needed
const corsOpts: cors.CorsOptions = {
  origin: CORS_ALLOWED_ORIGINS,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Authorization",
    "Content-Type",
    "Cache-Control",
    "Pragma",
    "X-Requested-With",
  ],
  exposedHeaders: ["Content-Length", "ETag"],
  credentials: true,
  maxAge: 60 * 60 * 24, // 1 day
};

app.use(cors(corsOpts));
app.options("*", cors(corsOpts)); // respond to all preflight checks

// ----------------------------------------------------------------------------
// Core middleware
// ----------------------------------------------------------------------------
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ----------------------------------------------------------------------------
// Static files (as in your existing setup)
//   - /public prefix
//   - default static with .html extension resolution
// Note: __dirname points to dist/ at runtime, so "../public" resolves to top-level public/
// ----------------------------------------------------------------------------
const pubPath = path.join(__dirname, "..", "public");
app.use("/public", express.static(pubPath, { maxAge: "1h", etag: true }));
app.use(express.static(pubPath, { extensions: ["html"], maxAge: "1h", etag: true }));

// (Optional) If you want to explicitly expose these pages even without extensions:
// app.get("/partners_login.html", (_req, res) => res.sendFile(path.join(pubPath, "partners_login.html")));
// app.get("/partners_app.html",   (_req, res) => res.sendFile(path.join(pubPath, "partners_app.html")));
// app.get("/partners_rooms.html", (_req, res) => res.sendFile(path.join(pubPath, "partners_rooms.html")));
// app.get("/partners_documents.html", (_req, res) => res.sendFile(path.join(pubPath, "partners_documents.html")));

// ----------------------------------------------------------------------------
// Health check
// ----------------------------------------------------------------------------
app.get("/health", (_req, res) => {
  // bump the string to force Render to restart cleanly if needed
  res.type("text/plain").send("OK v-ROUTES-21");
});

// ----------------------------------------------------------------------------
// Mount optional routers if they exist (dynamic import, non-fatal if absent)
// This avoids breaking the build if some files aren’t present yet.
// ----------------------------------------------------------------------------
async function tryMount(routePath: string, mountAt: string) {
  try {
    const m = await import(routePath);
    const r = (m.default ?? m.router ?? m) as express.Router;
    if (typeof r === "function") {
      app.use(mountAt, r);
      console.log(`[server] mounted ${mountAt} from ${routePath}`);
    } else {
      console.warn(`[server] ${routePath} did not export a router`);
    }
  } catch (err: any) {
    console.warn(`[server] optional route ${routePath} not mounted: ${err?.message || err}`);
  }
}

// Common locations you appear to have in dist:
//  - ./session
//  - ./routes/extranetRooms
//  - ./routes/extranetPms
//  - ./routes/property (if present)
//  - ./routes/propertyPhotos (if present)
await tryMount("./session.js", "/extranet"); // e.g., /extranet/session, /extranet/logout, etc.
await tryMount("./routes/extranetRooms.js", "/extranet"); // e.g., /extranet/rooms endpoints
await tryMount("./routes/extranetPms.js", "/extranet/pms"); // PMS router you shared
await tryMount("./routes/property.js", "/extranet/property"); // if you have a property router
await tryMount("./routes/propertyPhotos.js", "/extranet/property/photos"); // if present

// ----------------------------------------------------------------------------
// Fallback 404 for API routes (static will already have a default index-style behavior)
// ----------------------------------------------------------------------------
app.use((req, res, next) => {
  if (req.method === "GET" && req.accepts("html")) {
    // Let static middleware handle 404 page if you add one later
    return res.status(404).sendFile(path.join(pubPath, "404.html"), (err) => {
      if (err) res.status(404).type("text/plain").send("Not Found");
    });
  }
  next();
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[server] unhandled error:", err?.stack || err);
  res.status(500).json({ error: "Internal Server Error" });
});

// ----------------------------------------------------------------------------
// Start server (only if not started by an external runner/test)
// ----------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 3000);
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`[server] listening on port ${PORT} (public dir: ${pubPath})`);
  });
}

export default app;
