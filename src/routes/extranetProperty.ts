// src/routes/extranetProperty.ts
import { Router, Request, Response, NextFunction } from "express";
import { Pool } from "pg";

const r = Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- DB objects ---
const TBL_PROFILE = `extranet."PropertyProfile"`;

/** Helper: returns null for empty strings (trimmed); passthrough for non-strings */
function nz(v: unknown) {
  if (v == null) return null;
  if (typeof v !== "string") return v as any;
  const s = v.trim();
  return s.length ? s : null;
}

/** Normalizes all values in an object ("" -> null) */
function norm<T extends Record<string, any>>(obj: T) {
  const out: any = {};
  for (const [k, v] of Object.entries(obj ?? {})) out[k] = nz(v);
  return out as T;
}

/** Check all keys present on the body (even if null) */
function hasAllKeys(body: any, keys: string[]) {
  return keys.every((k) => Object.prototype.hasOwnProperty.call(body, k));
}

/** Safe date check (handles ms / seconds / ISO strings) */
function isExpired(expiresAt: unknown): boolean {
  if (expiresAt == null) return false;
  const v = String(expiresAt).trim();
  let t: number;

  if (/^\d{13}$/.test(v)) {
    t = parseInt(v, 10);            // epoch ms
  } else if (/^\d{10}$/.test(v)) {
    t = parseInt(v, 10) * 1000;     // epoch seconds -> ms
  } else {
    t = Date.parse(v);              // ISO or other parseable
  }

  return !Number.isFinite(t) || t <= Date.now();
}

function getClientIp(req: Request): string | null {
  // Prefer Render/CF/Proxy headers; fall back to Express
  const xf = (req.headers["x-forwarded-for"] as string) ?? "";
  if (xf) return xf.split(",")[0].trim();
  const xr = (req.headers["x-real-ip"] as string) ?? "";
  if (xr) return xr.trim();
  return (req.ip || "").trim() || null;
}

function getUserEmailFromReq(req: Request & { partner?: { email?: string } }): string | null {
  // Primary: session-derived partner email
  const a = (req.partner?.email ?? "").trim();
  if (a) return a;
  // Optional: allow upstream to pass it through a header if ever needed
  const h = (req.headers["x-user-email"] as string) ?? "";
  return h.trim() || null;
}

/** Write an audit row for PropertyProfile changes */
async function logProfileAudit(args: {
  partnerId: number;
  action: "PUT" | "PATCH";
  oldValue: any;
  newValue: any;
  ip?: string | null;
  userEmail?: string | null;
}) {
  // Table columns are lowercase (unquoted) in Postgres: partnerid, action, oldvalue, newvalue, ip, useremail
  await pool.query(
    `INSERT INTO extranet."PropertyProfileAudit"
       (partnerid, action, oldvalue, newvalue, ip, useremail)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)`,
    [
      args.partnerId,
      args.action,
      JSON.stringify(args.oldValue ?? null),
      JSON.stringify(args.newValue ?? null),
      args.ip ?? null,
      args.userEmail ?? null,
    ]
  );
}

/** Cache for detected session table (schema-qualified) */
let SESSION_TBL_CACHED: string | null = null;

/**
 * Find a table with columns token, partnerId, expiresAt (and optionally email, name).
 * Prefer schema 'extranet', else fall back to 'public'.
 */
async function detectSessionTable(): Promise<string> {
  if (SESSION_TBL_CACHED) return SESSION_TBL_CACHED;

  const { rows } = await pool.query(
    `
    WITH cols AS (
      SELECT table_schema, table_name, column_name
      FROM information_schema.columns
      WHERE table_schema IN ('extranet','public')
        AND column_name IN ('token','partnerId','expiresAt','email','name')
    ),
    candidates AS (
      SELECT table_schema, table_name
      FROM cols
      GROUP BY table_schema, table_name
      HAVING COUNT(*) FILTER (WHERE column_name = 'token') > 0
         AND COUNT(*) FILTER (WHERE column_name = 'partnerId') > 0
         AND COUNT(*) FILTER (WHERE column_name = 'expiresAt') > 0
    )
    SELECT table_schema, table_name
    FROM candidates
    ORDER BY (table_schema = 'extranet') DESC, table_name ASC
    LIMIT 1
    `
  );

  if (!rows.length) {
    throw new Error("No session table with token/partnerId/expiresAt found in schemas extranet/public");
  }

  const schema = rows[0].table_schema as string;
  const name   = rows[0].table_name as string;
  SESSION_TBL_CACHED = `${schema}."${name}"`;

  // Light debug so we can confirm in logs which table is used
  console.log(`[property] session table => ${SESSION_TBL_CACHED}`);

  return SESSION_TBL_CACHED;
}

/** List session-table candidates in both schemas */
async function listSessionCandidates(): Promise<Array<{ schema: string; name: string }>> {
  const { rows } = await pool.query(
    `
    WITH cols AS (
      SELECT table_schema, table_name, column_name
      FROM information_schema.columns
      WHERE table_schema IN ('extranet','public')
        AND column_name IN ('token','partnerId','expiresAt','email','name')
    ),
    candidates AS (
      SELECT table_schema, table_name
      FROM cols
      GROUP BY table_schema, table_name
      HAVING COUNT(*) FILTER (WHERE column_name = 'token') > 0
         AND COUNT(*) FILTER (WHERE column_name = 'partnerId') > 0
         AND COUNT(*) FILTER (WHERE column_name = 'expiresAt') > 0
    )
    SELECT table_schema, table_name
    FROM candidates
    ORDER BY (table_schema = 'extranet') DESC, table_name ASC
    `
  );
  return rows.map(r => ({ schema: r.table_schema as string, name: r.table_name as string }));
}

/** Quote an identifier safely */
function qident(id: string) {
  return `"${id.replace(/"/g, '""')}"`;
}

// ---- Auth guard: Bearer <UUID token> validated against any detected session table ----
async function requirePartner(
  req: Request & { partner?: { id: number; email?: string; name?: string } },
  res: Response,
  next: NextFunction
) {
  try {
    // Extract bearer token
    const auth = String(req.headers["authorization"] || "");
    const m = /^Bearer\s+(.+)$/.exec(auth);
    if (!m) return res.status(401).json({ error: "unauthorized" });
    const token = m[1].trim();

    // Try cached table first, then fall back to scanning all candidates
    const tried: string[] = [];
    const candidates: string[] = [];

    if (SESSION_TBL_CACHED) candidates.push(SESSION_TBL_CACHED);
    for (const c of await listSessionCandidates()) {
      const tbl = `${c.schema}.${qident(c.name)}`;
      if (!candidates.includes(tbl)) candidates.push(tbl);
    }

    let row:
      | { partnerId: number; email: string | null; name: string | null; expiresAt: string | number | null }
      | null = null;

    for (const tbl of candidates) {
      tried.push(tbl);
      // Support both real columns and jsonb(row) access; cast token to text for comparison
      const { rows } = await pool.query(
        `
        SELECT
          COALESCE( (to_jsonb(s)->>'partnerId')::int, NULLIF(s."partnerId", NULL)::int ) AS "partnerId",
          COALESCE( NULLIF(to_jsonb(s)->>'email',''), NULLIF(s."email"::text,'') )        AS "email",
          COALESCE( NULLIF(to_jsonb(s)->>'name',''),  NULLIF(s."name"::text,'') )         AS "name",
          COALESCE( to_jsonb(s)->>'expiresAt', (s."expiresAt")::text )                    AS "expiresAt"
        FROM ${tbl} s
        WHERE
          (to_jsonb(s)->>'token') = $1
          OR (s."token"::text = $1)
        LIMIT 1
        `,
        [token]
      );

      if (rows.length) {
        row = rows[0];
        SESSION_TBL_CACHED = tbl; // cache the winner
        break;
      }
    }

    if (!row) {
      console.warn(`[property:auth] token not found in candidates: ${tried.join(", ")}`);
      return res.status(401).json({ error: "unauthorized" });
    }

    // Honor numeric, string, or ISO timestamps
    if (isExpired(row.expiresAt)) return res.status(401).json({ error: "unauthorized" });

    req.partner = {
      id: Number(row.partnerId),
      email: row.email ?? undefined,
      name: row.name ?? undefined,
    };

    return next();
  } catch (e) {
    console.error("[property:auth] error", e);
    return res.status(401).json({ error: "unauthorized" });
  }
}

// All routes below require a valid partner session
r.use(requirePartner);

/** GET /extranet/property  -> returns the current partner’s profile */
r.get("/", async (req, res) => {
  const partnerId = (req as any)?.partner?.id;
  if (!partnerId) return res.status(401).json({ error: "unauthorized" });

  res.set("Cache-Control", "no-store, no-cache, must-revalidate");

  try {
    const { rows } = await pool.query(
      `SELECT "partnerId","name","contactEmail","phone","country",
              "addressLine","city","description","updatedAt","createdAt"
         FROM ${TBL_PROFILE}
        WHERE "partnerId" = $1`,
      [partnerId]
    );

    if (!rows.length) {
      return res.json({
        partnerId,
        name: null, contactEmail: null, phone: null, country: null,
        addressLine: null, city: null, description: null,
        createdAt: null, updatedAt: null,
      });
    }
    return res.json(rows[0]);
  } catch (e) {
    console.error("[property:get] db error", e);
    return res.status(500).json({ error: "Property fetch failed" });
  }
});

/**
 * PUT /extranet/property
 * Full replace (authoritative). Requires ALL fields present in body.
 * name is required non-empty.
 */
r.put("/", async (req, res) => {
  const partnerId = (req as any)?.partner?.id;
  if (!partnerId) return res.status(401).json({ error: "unauthorized" });

  res.set("Cache-Control", "no-store, no-cache, must-revalidate");

  const payload = req.body ?? {};
  const KEYS = ["name","contactEmail","phone","country","addressLine","city","description"];

  if (!hasAllKeys(payload, KEYS)) {
    return res.status(400).json({ error: "PUT requires full object: " + KEYS.join(", ") });
  }

  const data = norm({
    name:         payload.name,
    contactEmail: payload.contactEmail,
    phone:        payload.phone,
    country:      payload.country,
    addressLine:  payload.addressLine,
    city:         payload.city,
    description:  payload.description,
  });

  if (!data.name || typeof data.name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  try {
    // Pre-image for audit
    const { rows: wasRows } = await pool.query(
      `SELECT "partnerId","name","contactEmail","phone","country",
              "addressLine","city","description","updatedAt","createdAt"
         FROM ${TBL_PROFILE}
        WHERE "partnerId" = $1
        LIMIT 1`,
      [partnerId]
    );

    const { rows } = await pool.query(
      `INSERT INTO ${TBL_PROFILE}
         ("partnerId","name","contactEmail","phone","country",
          "addressLine","city","description","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW(), NOW())
       ON CONFLICT ("partnerId") DO UPDATE
           SET "name"         = EXCLUDED."name",
               "contactEmail" = EXCLUDED."contactEmail",
               "phone"        = EXCLUDED."phone",
               "country"      = EXCLUDED."country",
               "addressLine"  = EXCLUDED."addressLine",
               "city"         = EXCLUDED."city",
               "description"  = EXCLUDED."description",
               "updatedAt"    = NOW()
       RETURNING "partnerId","name","contactEmail","phone","country",
                 "addressLine","city","description","updatedAt","createdAt"`,
      [
        partnerId,
        data.name,
        data.contactEmail,
        data.phone,
        data.country,
        data.addressLine,
        data.city,
        data.description,
      ]
    );

    // Audit (best-effort)
    try {
      await logProfileAudit({
        partnerId,
        action: "PUT",
        oldValue: wasRows[0] ?? null,
        newValue: rows[0],
        ip: getClientIp(req),
        userEmail: getUserEmailFromReq(req),
      });
    } catch (e) {
      console.error("[property:put:audit] failed", e);
    }


    return res.json(rows[0]);
  } catch (e) {
    console.error("[property:put] db error", e);
    return res.status(500).json({ error: "Property save failed" });
  }
});

/**
 * PATCH /extranet/property
 * Partial update (merge). Absent fields are left unchanged.
 * Empty strings are normalized to null.
 * If no row exists yet, PATCH creates it — but requires 'name' to be provided.
 */
r.patch("/", async (req, res) => {
  const partnerId = (req as any)?.partner?.id;
  if (!partnerId) return res.status(401).json({ error: "unauthorized" });

  res.set("Cache-Control", "no-store, no-cache, must-revalidate");

  // Filter allowed keys only
  const allowed = new Set(["name","contactEmail","phone","country","addressLine","city","description"]);
  const incoming: Record<string, any> = {};
  for (const [k, v] of Object.entries(req.body ?? {})) {
    if (allowed.has(k)) incoming[k] = v;
  }

  const patchData = norm(incoming);

  try {
    // Read current (if any) — also used as audit pre-image
    const { rows: curRows } = await pool.query(
      `SELECT "partnerId","name","contactEmail","phone","country",
              "addressLine","city","description","updatedAt","createdAt"
         FROM ${TBL_PROFILE}
        WHERE "partnerId" = $1
        LIMIT 1`,
      [partnerId]
    );

    const curr = curRows[0] as
      | {
          partnerId: number;
          name: string | null;
          contactEmail: string | null;
          phone: string | null;
          country: string | null;
          addressLine: string | null;
          city: string | null;
          description: string | null;
        }
      | undefined;

    // If creating via PATCH, require name
    if (!curr && (patchData.name == null || patchData.name === "")) {
      return res.status(400).json({ error: "name is required to create profile" });
    }

    // Merge: provided keys override, others stay as-is
    const next = {
      name:         Object.prototype.hasOwnProperty.call(patchData, "name") ? patchData.name : (curr?.name ?? null),
      contactEmail: Object.prototype.hasOwnProperty.call(patchData, "contactEmail") ? patchData.contactEmail : (curr?.contactEmail ?? null),
      phone:        Object.prototype.hasOwnProperty.call(patchData, "phone") ? patchData.phone : (curr?.phone ?? null),
      country:      Object.prototype.hasOwnProperty.call(patchData, "country") ? patchData.country : (curr?.country ?? null),
      addressLine:  Object.prototype.hasOwnProperty.call(patchData, "addressLine") ? patchData.addressLine : (curr?.addressLine ?? null),
      city:         Object.prototype.hasOwnProperty.call(patchData, "city") ? patchData.city : (curr?.city ?? null),
      description:  Object.prototype.hasOwnProperty.call(patchData, "description") ? patchData.description : (curr?.description ?? null),
    };

    // Upsert merged state
    const { rows } = await pool.query(
      `INSERT INTO ${TBL_PROFILE}
         ("partnerId","name","contactEmail","phone","country",
          "addressLine","city","description","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW(), NOW())
       ON CONFLICT ("partnerId") DO UPDATE
           SET "name"         = EXCLUDED."name",
               "contactEmail" = EXCLUDED."contactEmail",
               "phone"        = EXCLUDED."phone",
               "country"      = EXCLUDED."country",
               "addressLine"  = EXCLUDED."addressLine",
               "city"         = EXCLUDED."city",
               "description"  = EXCLUDED."description",
               "updatedAt"    = NOW()
       RETURNING "partnerId","name","contactEmail","phone","country",
                 "addressLine","city","description","updatedAt","createdAt"`,
      [
        partnerId,
        next.name,
        next.contactEmail,
        next.phone,
        next.country,
        next.addressLine,
        next.city,
        next.description,
      ]
    );

    // Audit (best-effort)
    try {
      await logProfileAudit({
        partnerId,
        action: "PATCH",
        oldValue: curr ?? null,
        newValue: rows[0],
        ip: getClientIp(req),
        userEmail: getUserEmailFromReq(req),
      });
    } catch (e) {
      console.error("[property:patch:audit] failed", e);
    }


    return res.json(rows[0]);
  } catch (e) {
    console.error("[property:patch] db error", e);
    return res.status(500).json({ error: "Property patch failed" });
  }
});

export default r;
