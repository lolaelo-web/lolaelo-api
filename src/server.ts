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
// ----------------------------------------------------------------------------
const CORS_ALLOWED_ORIGINS = ["https://www.lolaelo.com"]; // add more if needed
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
// Static files
// Note: __dirname points to dist/ at runtime, so "../public" resolves to top-level public/
// ----------------------------------------------------------------------------
const pubPath = path.join(__dirname, "..", "public");
app.use("/public", express.static(pubPath, { maxAge: "1h", etag: true }));
app.use(express.static(pubPath, { extensions: ["html"], maxAge: "1h", etag: true }));

// ----------------------------------------------------------------------------
// Health check
// ----------------------------------------------------------------------------
app.get("/health", (_req, res) => {
  res.type("text/plain").send("OK v-ROUTES-22");
});

// ----------------------------------------------------------------------------
// Mount optional routers if they exist (dynamic import, non-fatal if absent)
// ----------------------------------------------------------------------------
async function tryMount(routePath: string, mountAt: string) {
  try {
    const m = await import(routePath);
    const r = (m.default ?? (m as any).router ?? m) as express.Router;
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

// IMPORTANT: session.js must be available at root for /login/*
// Mount at "/" AND at "/extranet" to keep both namespaces working.
await tryMount("./session.js", "/");          // enables /login/request-code, /login/verify, /extranet/session if defined at root
await tryMount("./session.js", "/extranet");  // keeps /extranet/session, /extranet/logout, etc.

// Other feature routers
await tryMount("./routes/extranetRooms.js", "/extranet");       // /extranet/rooms endpoints
await tryMount("./routes/extranetPms.js", "/extranet/pms");     // PMS router
await tryMount("./routes/property.js", "/extranet/property");   // if present
await tryMount("./routes/propertyPhotos.js", "/extranet/property/photos"); // if present

// ----------------------------------------------------------------------------
// Fallback 404 (API)
// ----------------------------------------------------------------------------
app.use((req, res, next) => {
  if (req.method === "GET" && req.accepts("html")) {
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
const PORT = Number(process.env.PORT || 3000);
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`[server] listening on port ${PORT} (public dir: ${pubPath})`);
  });
}

export default app;
