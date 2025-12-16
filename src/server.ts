// src/server.ts
import "dotenv/config";
import express, { type Router, type Request, type Response, type NextFunction } from "express";
import cors, { type CorsOptions } from "cors";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import { requireWriteToken } from "./middleware/requireWriteToken.js";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable("x-powered-by");

// ---- RatePlans (DB-backed, replaces in-memory ratePlanStore) ----
import { Pool } from "pg";

// Keep this near top-level in server.ts (same file) so it’s reused
const _cs_rp = process.env.DATABASE_URL || "";
const _wantsSSL_rp = /\bsslmode=require\b/i.test(_cs_rp) || /render\.com/i.test(_cs_rp);
const ratePlanPool = new Pool({
  connectionString: _cs_rp,
  ssl: _wantsSSL_rp ? { rejectUnauthorized: false } : undefined,
});

function isExpiredTs(expiresAt: any): boolean {
  if (!expiresAt) return false;
  const t = new Date(expiresAt).getTime();
  return Number.isNaN(t) ? false : t <= Date.now();
}

// Lightweight auth for write routes (matches your extranet session model)
async function requirePartnerId(req: Request): Promise<number> {
  const auth = String(req.headers["authorization"] || "");
  const m = /^Bearer\s+(.+)$/.exec(auth);
  let token = m ? m[1].trim() : "";
  if (!token) token = String(req.headers["x-partner-token"] || "").trim();
  if (!token) throw new Error("unauthorized:no_token");

  const { rows } = await ratePlanPool.query(
    `SELECT "partnerId","expiresAt","revokedAt"
       FROM extranet."ExtranetSession"
      WHERE "token" = $1
      LIMIT 1`,
    [token]
  );

  if (!rows.length) throw new Error("unauthorized:no_session");
  const s = rows[0];
  if (s.revokedAt) throw new Error("unauthorized:revoked");
  if (isExpiredTs(s.expiresAt)) throw new Error("unauthorized:expired");

  const pid = Number(s.partnerId);
  if (!Number.isFinite(pid) || pid <= 0) throw new Error("unauthorized:bad_partner");
  return pid;
}

// GET: read current plans for a room (public-friendly if propertyId/roomTypeId are provided)
app.get("/extranet/property/rateplans", async (req: Request, res: Response) => {
  try {
    res.set("Cache-Control", "no-store");

    const roomTypeId = Number((req.query as any).roomTypeId || 0);
    const propertyId = Number((req.query as any).propertyId || 0); // in your app this is effectively partnerId

    if (!Number.isFinite(roomTypeId) || roomTypeId <= 0) {
      return res.status(400).json({ error: "roomTypeId_required" });
    }

    // NOTE: We treat propertyId as partnerId (matches how catalog_details builds the URL)
    if (!Number.isFinite(propertyId) || propertyId <= 0) {
      return res.status(400).json({ error: "propertyId_required" });
    }

    const { rows } = await ratePlanPool.query(
      `
      SELECT
        "id",
        "name",
        COALESCE("code", 'RP' || "id"::text) AS "code",
        COALESCE("kind", 'NONE')            AS "kind",
        COALESCE("value", 0)                AS "value",
        COALESCE("active", true)            AS "active",
        COALESCE("isDefault", false)        AS "isDefault"
      FROM extranet."RatePlan"
      WHERE "partnerId" = $1
        AND "roomTypeId" = $2
        AND COALESCE("active", true) = true
      ORDER BY COALESCE("isDefault", false) DESC, "id" ASC
      `,
      [propertyId, roomTypeId]
    );

    return res.json(rows);
  } catch (e) {
    console.error("[rateplans:get] db error:", e);
    return res.status(500).json({ error: "rateplans_get_failed" });
  }
});

// POST: upsert rateplan rules + active/default flags (AUTH REQUIRED)
app.post("/extranet/property/rateplans", express.json(), async (req: Request, res: Response) => {
  const client = await ratePlanPool.connect();
  try {
    res.set("Cache-Control", "no-store");

    const authedPartnerId = await requirePartnerId(req);

    const body: any = req.body || {};
    const roomTypeId = Number(body.roomTypeId || 0);
    const plans = Array.isArray(body.plans) ? body.plans : [];

    if (!Number.isFinite(roomTypeId) || roomTypeId <= 0) {
      return res.status(400).json({ error: "roomTypeId_required" });
    }
    if (!plans.length) return res.status(400).json({ error: "no_plans" });

    // Guard: room must belong to this partner
    const own = await client.query(
      `SELECT "id" FROM extranet."RoomType" WHERE "id"=$1 AND "partnerId"=$2 LIMIT 1`,
      [roomTypeId, authedPartnerId]
    );
    if (!own.rowCount) return res.status(403).json({ error: "forbidden" });

    await client.query("BEGIN");

    // Normalize + upsert
    for (const p of plans) {
      if (!p || typeof p !== "object") continue;

      const id = Number(p.id || 0);
      const name = (typeof p.name === "string" && p.name.trim()) ? p.name.trim().slice(0, 60) : null;

      const code =
        (typeof p.code === "string" && p.code.trim())
          ? p.code.trim().toUpperCase().slice(0, 10)
          : null;

      const kindRaw =
        (typeof p.kind === "string" && p.kind.trim())
          ? p.kind.trim().toUpperCase().slice(0, 12)
          : "NONE";

      const kind = ["NONE", "PERCENT", "ABSOLUTE"].includes(kindRaw) ? kindRaw : "NONE";

      let value = Number(p.value);
      if (!Number.isFinite(value)) value = 0;
      if (kind === "PERCENT") value = Math.max(-100, Math.min(100, value));
      if (kind === "ABSOLUTE") value = Math.max(-100000, Math.min(100000, value));
      if (kind === "NONE") value = 0;

      const active = (p.active === false || p.active === "false" || p.active === 0 || p.active === "0") ? false : true;
      const isDefault = (p.isDefault === true || p.isDefault === "true" || p.isDefault === 1 || p.isDefault === "1") ? true : false;

      if (id > 0) {
        await client.query(
          `
          UPDATE extranet."RatePlan"
             SET "name" = COALESCE($1, "name"),
                 "code" = COALESCE($2, "code"),
                 "kind" = $3,
                 "value" = $4,
                 "active" = $5,
                 "isDefault" = $6,
                 "updatedAt" = NOW()
           WHERE "id" = $7
             AND "partnerId" = $8
             AND "roomTypeId" = $9
          `,
          [name, code, kind, value, active, isDefault, id, authedPartnerId, roomTypeId]
        );
      } else {
        // create new
        await client.query(
          `
          INSERT INTO extranet."RatePlan"
            ("partnerId","roomTypeId","name","code","kind","value","active","isDefault","createdAt","updatedAt")
          VALUES
            ($1,$2,COALESCE($3,'Custom'),COALESCE($4,NULL),$5,$6,$7,$8,NOW(),NOW())
          `,
          [authedPartnerId, roomTypeId, name, code, kind, value, active, isDefault]
        );
      }
    }

    // Enforce single default per roomTypeId (if multiple were set true)
    await client.query(
      `
      WITH d AS (
        SELECT "id"
        FROM extranet."RatePlan"
        WHERE "partnerId"=$1 AND "roomTypeId"=$2 AND COALESCE("isDefault",false)=true
        ORDER BY "id" ASC
        LIMIT 1
      )
      UPDATE extranet."RatePlan" rp
         SET "isDefault" = (rp."id" IN (SELECT "id" FROM d))
       WHERE rp."partnerId"=$1 AND rp."roomTypeId"=$2
      `,
      [authedPartnerId, roomTypeId]
    );

    await client.query("COMMIT");

    // Return fresh list
    const { rows } = await client.query(
      `
      SELECT "id","name",
             COALESCE("code",'RP' || "id"::text) AS "code",
             COALESCE("kind",'NONE') AS "kind",
             COALESCE("value",0)     AS "value",
             COALESCE("active",true) AS "active",
             COALESCE("isDefault",false) AS "isDefault"
      FROM extranet."RatePlan"
      WHERE "partnerId"=$1 AND "roomTypeId"=$2
      ORDER BY COALESCE("isDefault",false) DESC, "id" ASC
      `,
      [authedPartnerId, roomTypeId]
    );

    return res.json({ ok: true, roomTypeId, plans: rows });
  } catch (e: any) {
    await client.query("ROLLBACK");
    console.error("[rateplans:post] error:", e?.message || e);
    const msg = String(e?.message || "");
    if (msg.startsWith("unauthorized:")) return res.status(401).json({ error: "unauthorized" });
    return res.status(500).json({ error: "rateplans_post_failed" });
  } finally {
    client.release();
  }
});
// ---- RatePlans END ----

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
  res.type("text/plain").send("OK v-ROUTES-32");
});

// ANCHOR: HEALTHZ_ROUTE
app.get("/healthz", async (_req, res) => {
  try {
    const cs = process.env.DATABASE_URL || "";
    if (!cs) return res.status(200).json({ ok: true, db: "skipped (no DATABASE_URL)" });

    const wantsSSL = /\bsslmode=require\b/i.test(cs) || /render\.com/i.test(cs);
    const client = new Client({
      connectionString: cs,
      ssl: wantsSSL ? { rejectUnauthorized: false } : undefined,
    });
    await client.connect();
    await client.query("select 1");
    await client.end();

    res.status(200).json({ ok: true });
  } catch (err: any) {
    res.status(503).json({ ok: false, error: String(err?.message || err).slice(0, 200) });
  }
});
// ANCHOR: HEALTHZ_ROUTE END

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
await tryMount("./routes/extranetUisMock.js", "/extranet/pms");
await tryMount("./routes/extranetProperty.js", "/extranet/property");
await tryMount("./routes/catalog.js", "/catalog");

/* ANCHOR: MOCK_UIS_SEARCH (Siargao) */
app.get("/mock/uis/search", async (req: Request, res: Response) => {
  try {
    const { start, end, guests } = req.query as {
      start?: string; end?: string; guests?: string;
    };

    if (!start || !end) {
      return res.status(400).json({ error: "missing_dates" });
    }
    if (end <= start) {
      return res.status(400).json({ error: "bad_range" });
    }
    const g = Math.max(1, Number(guests || 2));

    // Load the mock data module (ESM-safe)
    const modUrl = pathToFileURL(
      path.join(__dirname, "..", "data", "siargao_hotels.js")
    ).href;
    const mod: any = await import(modUrl);

    // Prefer a generator if the file exports one
    const gen =
      mod?.getMockResults ||
      mod?.buildMockResults ||
      mod?.buildMockUIS ||
      mod?.default?.getMockResults ||
      null;

    if (typeof gen === "function") {
      const out = await gen(String(start), String(end), g);
      const payload = {
        extranet: Array.isArray(out?.extranet) ? out.extranet : (Array.isArray(out) ? out : []),
        pms: Array.isArray(out?.pms) ? out.pms : [],
      };
      return res.json(payload);
    }

    // Otherwise, synthesize rows from an exported hotels[] structure
    const hotels: any[] =
      (Array.isArray(mod?.hotels) && mod.hotels) ||
      (Array.isArray(mod?.default) && mod.default) ||
      (Array.isArray(mod?.default?.hotels) && mod.default.hotels) ||
      [];

    if (!hotels.length) {
      return res.status(500).json({ error: "mock_module_missing", note: "Expected getMockResults() or hotels[] export." });
    }

    const ONE = 86400000;
    const sT = new Date(start + "T00:00:00Z").getTime();
    const eT = new Date(end   + "T00:00:00Z").getTime();

    const rows: any[] = [];
    for (let t = sT; t < eT; t += ONE) {
      const dISO = new Date(t).toISOString().slice(0, 10);
      for (const h of hotels) {
        const rooms = Array.isArray(h.rooms) && h.rooms.length ? h.rooms : [{}];
        for (const rm of rooms) {
          rows.push({
            date: dISO,
            source: "direct",
            name: `${h.name ?? "Hotel"} — ${rm.name ?? "Room"}`,
            maxGuests: Number(rm.maxGuests ?? h.maxGuests ?? 2),
            price: Number(rm.basePrice ?? h.basePrice ?? 100),
            ratePlanId: 1,
            propertyId: h.id ?? undefined,
          });
        }
      }
    }

    res.json({ extranet: rows, pms: [] });
  } catch (e) {
    console.error("MOCK_UIS_SEARCH error", e);
    res.status(500).json({ error: "mock_uis_failed" });
  }
});

// ---- Session probe (TEMP, safe to remove later) ----
app.get("/__session_probe_public", async (_req, res) => {
  try {
    const cs = process.env.DATABASE_URL || "";
    const wantsSSL = /\bsslmode=require\b/i.test(cs) || /render\.com/i.test(cs);
    const client = new Client({
      connectionString: cs,
      ssl: wantsSSL ? { rejectUnauthorized: false } : undefined,
    });
    await client.connect();

    // Find a candidate session table in extranet/ public with token+partnerId+expiresAt-ish
    const meta = await client.query(`
      WITH cols AS (
        SELECT table_schema, table_name, column_name
        FROM information_schema.columns
        WHERE table_schema IN ('extranet','public')
          AND column_name IN ('token','sessionToken','session_token','authToken','bearer','id',
                              'partnerId','partner_id','partnerid',
                              'expiresAt','expires_at','expiry','expires')
      ),
      cand AS (
        SELECT table_schema, table_name,
               COUNT(*) FILTER (WHERE column_name IN ('token','sessionToken','session_token','authToken','bearer','id')) AS has_token,
               COUNT(*) FILTER (WHERE column_name IN ('partnerId','partner_id','partnerid')) AS has_partner,
               COUNT(*) FILTER (WHERE column_name IN ('expiresAt','expires_at','expiry','expires')) AS has_expiry
        FROM cols
        GROUP BY table_schema, table_name
      )
      SELECT table_schema, table_name
      FROM cand
      WHERE has_token > 0 AND has_partner > 0 AND has_expiry > 0
      ORDER BY (table_schema = 'extranet') DESC, table_name ASC
      LIMIT 1
    `);

    if (!meta.rows.length) {
      await client.end();
      return res.json({ ok: false, error: "No candidate session table found" });
    }

    const schema = String(meta.rows[0].table_schema);
    const name   = String(meta.rows[0].table_name);

    const sample = await client.query(`SELECT to_jsonb(s) AS j FROM ${schema}."${name}" s LIMIT 3`);
    const sampleJson = sample.rows.map(r => r.j ?? {});
    const keys = Array.from(new Set(sampleJson.flatMap(obj => Object.keys(obj || {}))));

    await client.end();
    res.json({ ok: true, schema, table: name, keys, sample: sampleJson });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---- Schema tables/columns probe (TEMP) ----
app.get("/__tables_public", async (_req, res) => {
  try {
    const cs = process.env.DATABASE_URL || "";
    const wantsSSL = /\bsslmode=require\b/i.test(cs) || /render\.com/i.test(cs);
    const client = new Client({
      connectionString: cs,
      ssl: wantsSSL ? { rejectUnauthorized: false } : undefined,
    });
    await client.connect();

    const q = await client.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'extranet'
      ORDER BY table_name, ordinal_position
    `);

    // group columns by table_name for readability
    const grouped: Record<string, Array<{ column: string; type: string }>> = {};
    for (const r of q.rows) {
      const t = r.table_name as string;
      if (!grouped[t]) grouped[t] = [];
      grouped[t].push({ column: r.column_name, type: r.data_type });
    }

    await client.end();
    res.json({ ok: true, schema: "extranet", tables: grouped });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---- Diagnostics ----
app.get("/__ping", (_req, res) => {
  res.status(200).json({ ok: true, now: new Date().toISOString() });
});

// DB info (which DB/user/host are we actually connected to?)
app.get("/__dbinfo", async (_req, res) => {
  try {
    const cs = process.env.DATABASE_URL || "";
    const wantsSSL = /\bsslmode=require\b/i.test(cs) || /render\.com/i.test(cs);
    const client = new Client({
      connectionString: cs,
      ssl: wantsSSL ? { rejectUnauthorized: false } : undefined,
    });
    await client.connect();
    const { rows } = await client.query(`
      SELECT
        current_database() AS db,
        current_user       AS "user",
        inet_server_addr() AS host,
        inet_server_port() AS port,
        now()              AS db_now
    `);
    await client.end();
    res.json({ ok: true, ...rows[0] });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
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

// ANCHOR: UIS_MOCK_SEARCH
import * as HotelsData from "../data/siargao_hotels.js"; // path is: src -> data
// Adapter (mock for now; DB later)
import { getSearchList, getDetails as getDetailsFromAdapter, getCurrency } from "./adapters/catalogSource.js";
import type { Currency } from "./readmodels/catalog.js";
// Read-model projector for Catalog
import { projectCatalogProperty } from "./readmodels/catalog.js";

// Public mock search (extranet-only for now) — moved off the live path
app.get("/mock/catalog/search", (req: Request, res: Response) => {
  const start  = String(req.query.start || new Date().toISOString().slice(0, 10));
  const end    = String(req.query.end   || start);
  const guests = Math.max(1, parseInt(String(req.query.guests ?? "2"), 10));
  const q = String(req.query.q ?? "").trim().toLowerCase();

  const payload = HotelsData.searchAvailability({
    start, end,
    currency: HotelsData.CURRENCY,
    ratePlanId: 1,
  });

  // Filter by guests using the single mock room per hotel
  const filtered = {
    ...payload,
    properties: payload.properties.filter((p: any) => {
      const h = HotelsData.HOTELS.find((x: any) => x.id === p.propertyId);
      const max = h?.rooms?.[0]?.maxGuests ?? 1;
      return max >= guests;
    }),
  };

  res.json(filtered);
});

// ANCHOR:: CATALOG_SEARCH
// Returns property-level cards (name, city, images, fromPrice, availability summary)
app.get("/catalog/search", async (req: Request, res: Response) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const start = String(req.query.start || today);
    const end   = String(req.query.end   || start);
    const guests = Math.max(1, parseInt(String(req.query.guests || "2"), 10));
    const q = String(req.query.q ?? "").trim().toLowerCase(); // optional text filter

    // nights in range
    const startMs = new Date(start + "T00:00:00Z").getTime();
    const endMs   = new Date(end   + "T00:00:00Z").getTime();
    const nightsTotal = Math.max(0, Math.round((endMs - startMs) / 86400000));

    // Base list (via adapter wrapping mock for now)
    const data = await getSearchList({ start, end, ratePlanId: 1 });
    const list: any[] = Array.isArray((data as any)?.properties) ? (data as any).properties : [];

    // Pull Partner Hub profiles/photos and merge (availability still from mock)
    const ids = list.map((p: any) => Number(p.propertyId ?? p.id)).filter((n: any) => Number.isFinite(n));
    const dbProfiles = await (await import("./adapters/catalogSource.js")).getProfilesFromDb(ids);

    // Optional text filter by name/city/country from ?q=
    const prefiltered: any[] = q
      ? list.filter((p: any) => {
          const hay = `${p?.name || ""} ${p?.city || ""} ${p?.country || ""}`.toLowerCase();
          return hay.includes(q);
        })
      : list;

    // Currency (typed to the readmodel literal type)
    const currency: Currency = await getCurrency();

    // Project each property using the read-model helper (async-safe loop)
    const properties: any[] = [];
    for (const p of prefiltered) {
      // guest filter (using primary room capacity when available)
      const h = (HotelsData as any).HOTELS?.find?.((x: any) => x.id === (p.propertyId ?? p.id));
      const maxGuests = h?.rooms?.[0]?.maxGuests ?? 2;
      if (maxGuests < guests) continue;

      // per-property detail via adapter to obtain room daily arrays
      const detail = await getDetailsFromAdapter({
        propertyId: Number(p.propertyId ?? p.id),
        start,
        end,
        ratePlanId: 1,
      });

            // Build roomsDaily (normalized daily rows for UI)
      const roomsDaily =
        Array.isArray(detail?.rooms)
          ? detail.rooms.map((r: any) =>
              Array.isArray(r.daily)
                ? r.daily.map((d: any) => ({
                    date: String(d.date),
                    price: typeof d.price === "number" ? d.price : null,
                    open: !d.closed && (d.open > 0 || d.open === true),
                    minStay: typeof d.minStay === "number" ? d.minStay : undefined,
                  }))
                : []
            )
          : [];

      // Prefer DB profile/photos if present; fall back to mock
      const pidNum = Number(p.propertyId ?? p.id);
      const prof   = dbProfiles[pidNum];
      const mergedImages: string[] =
        (prof?.images?.length ? prof.images : (Array.isArray(p.images) ? p.images : []));

      // Debug: log which image wins for this property
      console.log(
        "[catalog.search] pid=%s img0=%s (db0=%s mock0=%s)",
        pidNum,
        mergedImages?.[0] ?? null,
        prof?.images?.[0] ?? null,
        Array.isArray(p.images) ? p.images[0] : null
      );

            // Project into the stable CatalogProperty shape
      properties.push(
        projectCatalogProperty({
          propertyId: String(p.propertyId ?? p.id),
          name: String((prof?.name) ?? p.name ?? ""),
          city: String((prof?.city) ?? p.city ?? ""),
          country: String((prof?.country) ?? p.country ?? ""),
          images: mergedImages,
          amenities: Array.isArray(p.amenities) ? p.amenities : [],
          roomsDaily,
          nightsTotal,
          starRating: typeof p.starRating === "number" ? p.starRating : undefined,
          currency, // literal "USD" type from adapter
          updatedAtISO: new Date().toISOString(),
        })
      );
    }

    // respond
    res.json({
      ok: true,
      start,
      end,
      guests,
      q: q || undefined,
      count: properties.length,
      properties
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}); // <-- end /catalog/search


// Details for a single property (projects into CatalogDetails shape)
app.get("/catalog/details", async (req: Request, res: Response) => {
  const propertyId = Number(req.query.propertyId);
  const start = String(req.query.start || new Date().toISOString().slice(0, 10));
  const end   = String(req.query.end   || start);
  const ratePlanId = Number(req.query.ratePlanId || 1);

  if (!Number.isFinite(propertyId)) {
    res.status(400).json({ ok: false, error: "propertyId is required" });
    return;
  }

  try {
    const payload = await getDetailsFromAdapter({ propertyId, start, end, ratePlanId }) ?? null;

    if (!payload) {
      res.status(404).json({ ok: false, error: "Not found" });
      return;
    }
    res.json(payload);
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /catalog/property/:id?start=YYYY-MM-DD&end=YYYY-MM-DD&guests=2
app.get("/catalog/property/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ ok: false, error: "Invalid id" });
      return;
    }

    const today  = new Date().toISOString().slice(0, 10);
    const start  = String(req.query.start || today);
    const end    = String(req.query.end   || start);
    const guests = Math.max(1, parseInt(String(req.query.guests ?? "2"), 10));

    const payload = await getDetailsFromAdapter({
      propertyId: id,
      start,
      end,
      ratePlanId: 1,
    });

    if (!payload) {
      res.status(404).json({ ok: false, error: "Not found" });
      return;
    }

    res.json(payload);
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * GET /extranet/pms/uis/search?start=YYYY-MM-DD&end=YYYY-MM-DD&guests=2
 * Returns { extranet:[], pms:[] } so the UI can merge both.
 */
app.get("/extranet/pms/uis/search", async (req: Request, res: Response) => {
  // ---- parse inputs (typed) ----
  const start: string  = String(req.query.start || new Date().toISOString().slice(0, 10));
  const end: string    = String(req.query.end   || start);
  const guests: number = Math.max(1, parseInt(String(req.query.guests ?? "2"), 10));

  // ---- build inclusive date list ----
  const ONE_DAY = 86_400_000;
  const dates: string[] = [];
  for (
    let d = new Date(start + "T00:00:00Z"), e = new Date(end + "T00:00:00Z");
    d <= e;
    d = new Date(d.getTime() + ONE_DAY)
  ) {
    dates.push(d.toISOString().slice(0, 10));
  }

  // ---- load mock data/functions (JS module, no types) ----
  // @ts-ignore - JS module without TS typings
  const mod: any = await import("../data/siargao_hotels.js");
  const searchAvailability = mod.searchAvailability as (args: { start: string; end: string }) => any;
  const getAvailability    = mod.getAvailability    as (args: { propertyId: number; start: string; end: string }) => any;

  // ---- build rows (PMS mirrors extranet for now) ----
  const extranet: Array<Record<string, any>> = [];
  const pms: Array<Record<string, any>> = [];

  const list = searchAvailability({ start, end });
  const props: any[] = Array.isArray(list?.properties) ? list.properties : [];

  for (const prop of props) {
    const detail = getAvailability({ propertyId: Number(prop.propertyId), start, end });
    const room   = detail?.rooms?.[0];
    if (!room) continue;
    if (guests > (room.maxGuests ?? 2)) continue;

    for (const day of (room.daily as any[])) {
      if (day.closed || day.open <= 0 || typeof day.price !== "number") continue;

      const row = {
        date: day.date,
        source: "extranet",
        name: prop.name,
        maxGuests: room.maxGuests ?? 2,
        price: day.price,
        ratePlanId: detail?.ratePlanId ?? 1,
      };
      extranet.push(row);
      pms.push({ ...row, source: "pms" });
    }
  }

  res.json({ extranet, pms });
});

// /ANCHOR: UIS_MOCK_SEARCH

// Simple test endpoint: creates a Stripe Checkout Session with booking metadata
app.post("/api/payments/create-checkout-session", async (req: Request, res: Response) => {
  try {
    const body: any = req.body ?? {};

    const propertyId = body.propertyId ?? null;
    const roomId     = body.roomId ?? null;
    const start      = body.start ?? null;
    const end        = body.end ?? null;
    const ratePlanId = body.ratePlanId ?? null;
    const rawAddons  = Array.isArray(body.addons) ? body.addons : [];

    // Light sanitization of add-ons so we can safely attach to metadata / logs
    const addons = rawAddons.map((a: any) => ({
      index: typeof a.index === "number" ? a.index : null,
      quantity:
        typeof a.quantity === "number"
          ? a.quantity
          : Number(a.quantity ?? 0),
      activity: (a.activity ?? "").toString().slice(0, 120),
      uom: (a.uom ?? "").toString().slice(0, 40),
      price:
        typeof a.price === "number"
          ? a.price
          : (a.price != null ? Number(a.price) : null),
      travelerComment: (a.travelerComment ?? "").toString().slice(0, 500),
      lineTotal:
        typeof a.lineTotal === "number"
          ? a.lineTotal
          : null,
    }));

    if (addons.length) {
      console.log("[checkout] received addons:", {
        propertyId,
        roomId,
        start,
        end,
        ratePlanId,
        addonsCount: addons.length,
      });
    }

    const metadata: Record<string, string> = {
      propertyId: propertyId != null ? String(propertyId) : "",
      roomId: roomId != null ? String(roomId) : "",
      start: start != null ? String(start) : "",
      end: end != null ? String(end) : "",
      ratePlanId: ratePlanId != null ? String(ratePlanId) : "",
    };

    try {
      const addonsJson = JSON.stringify(addons);
      if (addonsJson && addonsJson.length <= 5000) {
        metadata["addons"] = addonsJson;
      }
    } catch {
      // ignore metadata serialization errors
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd", // test currency for now
            product_data: {
              name: "Lolaelo test booking",
            },
            unit_amount: 5000, // 50.00 USD in smallest unit (cents)
          },
          quantity: 1,
        },
      ],
      success_url:
        "https://lolaelo-api.onrender.com/checkout_success.html?session_id={CHECKOUT_SESSION_ID}",
      cancel_url:
        "https://lolaelo-api.onrender.com/checkout_cancelled.html",
      metadata,
    });

    return res.json({ url: session.url });
  } catch (err: any) {
    console.error("Error creating checkout session:", err);
    return res.status(500).json({
      error: "stripe_error",
      message: err?.message ?? "Unknown error",
    });
  }
});

// ---- Stripe webhook (test stub) ----
app.post("/api/payments/webhook", (req: Request, res: Response) => {
  console.log("Stripe webhook hit:", req.body?.type ?? "no type");
  // We will add proper signature verification and booking linkage later
  res.json({ received: true });
});

export default app;
