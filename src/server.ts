// src/server.ts
import "dotenv/config";
import express, { type Router, type Request, type Response, type NextFunction } from "express";
import cors, { type CorsOptions } from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { requireWriteToken } from "./middleware/requireWriteToken.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable("x-powered-by");

// ---- CORS ----
const CORS_ALLOWED_ORIGINS = [
  "https://www.lolaelo.com",
  "https://lolaelo.com",
];
const corsOpts: CorsOptions = {
  origin: CORS_ALLOWED_ORIGINS,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
  // reflect requested headers (incl. Authorization, x-partner-token)
  allowedHeaders: undefined,
  exposedHeaders: ["Content-Length", "ETag"],
  credentials: true,
  maxAge: 60 * 60 * 24,
};
app.use(cors(corsOpts));
app.options("*", cors(corsOpts));

// ---- Core ----
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ---- Static ----
const pubPath = path.join(__dirname, "..", "public");
app.use("/public", express.static(pubPath, { maxAge: "1h", etag: true }));
app.use(express.static(pubPath, { extensions: ["html"], maxAge: "1h", etag: true }));

// ---- Health ----
app.get("/health", (_req, res) => {
  res.type("text/plain").send("OK v-ROUTES-29");
});

// Track mounts so we can enumerate routes later
const mountedRouters: Array<{ base: string; router: Router; source: string }> = [];

// ---- Dynamic route mounting helper ----
async function tryMount(routePath: string, mountAt: string) {
  try {
    const m = await import(routePath);
    const r = (m.default ?? (m as any).router ?? m) as Router;
    if (typeof r === "function") {
      app.use(mountAt, r);
      mountedRouters.push({ base: mountAt, router: r, source: routePath });
      console.log(`[server] mounted ${mountAt} from ${routePath}`);
    } else {
      console.warn(`[server] ${routePath} did not export a router`);
    }
  } catch (err: any) {
    console.warn(`[server] optional route ${routePath} not mounted: ${err?.message || err}`);
  }
}

// ---- Routers ----
// session at / and /extranet
await tryMount("./routes/sessionHttp.js", "/");
await tryMount("./routes/sessionHttp.js", "/extranet");

// features
await tryMount("./routes/extranetRooms.js", "/extranet/property/rooms");
await tryMount("./routes/extranetPms.js", "/extranet/pms");
await tryMount("./routes/extranetProperty.js", "/extranet/property"); 

// write-guard for property writes
app.use("/extranet/property", requireWriteToken);

// ---- Diagnostics ----
app.get("/__ping", (_req, res) => {
  res.status(200).json({ ok: true, now: new Date().toISOString() });
});

function extractRouterRoutes(
  r: any,
  base: string,
  out: Array<{ path: string; methods: string[]; source?: string }>
) {
  const stack = r?.stack ?? [];
  for (const layer of stack) {
    if (layer?.route) {
      const p = String(layer.route.path || "");
      const methods = Object.keys(layer.route.methods || {}).map((m) => m.toUpperCase());
      out.push({ path: base + (p === "/" ? "" : p), methods });
    } else if (layer?.name === "router" && layer?.handle?.stack) {
      extractRouterRoutes(layer.handle, base, out);
    }
  }
}

app.get("/__routes_public", (_req, res) => {
  const routes: Array<{ path: string; methods: string[]; source?: string }> = [];

  // app-level routes registered directly on `app`
  const appStack: any[] = (app as any)?._router?.stack ?? [];
  for (const layer of appStack) {
    if (layer?.route) {
      const p = String(layer.route.path || "");
      const methods = Object.keys(layer.route.methods || {}).map((m) => m.toUpperCase());
      routes.push({ path: p || "/", methods });
    }
  }

  // mounted routers
  for (const m of mountedRouters) {
    extractRouterRoutes(m.router, m.base, routes);
  }

  // sort & unique
  const key = (r: { path: string; methods: string[] }) => `${r.path}::${r.methods.sort().join(",")}`;
  const uniq = Array.from(new Map(routes.map((r) => [key(r), r])).values()).sort((a, b) =>
    a.path.localeCompare(b.path)
  );

  res.json(uniq);
});

app.get("/__dbping_public", async (_req, res) => {
  try {
    const cs = process.env.DATABASE_URL || "";
    const wantsSSL = /\bsslmode=require\b/i.test(cs) || /render\.com/i.test(cs);
    const client = new Client({
      connectionString: cs,
      ssl: wantsSSL ? { rejectUnauthorized: false } : undefined,
    });
    await client.connect();
    const r = await client.query(
      'select version(), current_database() as db, inet_server_addr() as host, now()'
    );
    await client.end();
    res.json({
      ok: true,
      version: r.rows?.[0]?.version ?? null,
      db: r.rows?.[0]?.db ?? null,
      host: r.rows?.[0]?.host ?? null,
      dbNow: r.rows?.[0]?.now ?? null,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---- 404 for HTML, JSON for others ----
app.use((req, res, next) => {
  if (req.method === "GET" && req.accepts("html")) {
    return res.status(404).sendFile(path.join(pubPath, "404.html"), (err) => {
      if (err) res.status(404).type("text/plain").send("Not Found");
    });
  }
  next();
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[server] unhandled error:", err?.stack || err);
  res.status(500).json({ error: "Internal Server Error" });
});

const PORT = Number(process.env.PORT || 3000);
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`[server] listening on port ${PORT} (public dir: ${pubPath})`);
  });
}

export default app;
