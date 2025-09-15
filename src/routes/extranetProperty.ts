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

  const { rows } = await pool.query(`
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
  `);

  if (!rows.length) {
    throw new Error("No session table with token/partnerId/expiresAt found in schemas extranet/public");
  }

  const schema = rows[0].table_schema as string;
  const name   = rows[0].table_name as string;
  SESSION_TBL_CACHED = `${schema}."${name}"`;

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

/** Return session row from extranet view; null if missing */
async function getSessionRow(token: string): Promise<null | {
  partnerId: number;
  expiresAt: any;
  revokedAt: any;
  _tbl: 'extranet."ExtranetSession"';
}> {
  const q = `SELECT "partnerId","expiresAt","revokedAt"
             FROM extranet."ExtranetSession"
             WHERE "token" = $1
             LIMIT 1`;
  const r = await pool.query(q, [token]);
  if (r.rowCount) return { ...r.rows[0], _tbl: 'extranet."ExtranetSession"' };
  return null;
}

// ---- Auth guard: Bearer <UUID token> validated against detected session table ----
async function requirePartner(
  req: Request & { partner?: { id: number; email?: string; name?: string } },
  res: Response,
  next: NextFunction
) {
  try {
    const auth = String(req.headers["authorization"] || "");
    const m = /^Bearer\s+(.+)$/.exec(auth);
    if (!m) {
      console.log("[property:auth] no bearer header");
      return res.status(401).json({ error: "unauthorized" });
    }
    const token = m[1].trim();
    console.log("[property:auth] bearer prefix:", token.slice(0, 8));

    // Dual-schema lookup (public -> extranet)
    const row = await getSessionRow(token);
    if (!row) return res.status(401).json({ error: "unauthorized" });
    if (row.revokedAt) return res.status(401).json({ error: "unauthorized" });
    if (isExpired(row.expiresAt)) return res.status(401).json({ error: "unauthorized" });

    req.partner = { id: Number(row.partnerId) };
    return next();
  } catch (e) {
    console.error("[property:auth] error", e);
    return res.status(401).json({ error: "unauthorized" });
  }
}

// --- debug: probe the current token against whatever session table we detect ---
r.get("/__probe_session", async (req, res) => {
  try {
    const auth = String(req.headers["authorization"] || "");
    const m = /^Bearer\s+(.+)$/.exec(auth);
    if (!m) return res.status(401).json({ ok: false, error: "unauthorized" });
    const token = m[1].trim();

    const sessionTbl = await detectSessionTable();

    // JSONB-only selectors (no direct "email"/"name" columns expected)
    const q = `
      SELECT
        (to_jsonb(s)->>'partnerId')::int AS "partnerId",
        to_jsonb(s)->>'email'            AS "email",
        to_jsonb(s)->>'name'             AS "name",
        to_jsonb(s)->>'expiresAt'        AS "expiresAt",
        to_jsonb(s)->>'token'            AS "token_text"
      FROM ${sessionTbl} s
      WHERE to_jsonb(s)->>'token' = $1
      LIMIT 1
    `;
    const { rows } = await pool.query(q, [token]);

    if (!rows.length) {
      return res.json({ ok: true, found: false, sessionTbl });
    }
    const s = rows[0] as {
      partnerId: number;
      email: string | null;
      name: string | null;
      expiresAt: string | null;
      token_text: string | null;
    };

    return res.json({
      ok: true,
      found: true,
      sessionTbl,
      partnerId: s.partnerId,
      email: s.email ?? null,
      name: s.name ?? null,
      expiresAt: s.expiresAt ?? null,
      token: s.token_text ?? null,
    });
  } catch (e) {
    console.error("[property:__probe_session] error", e);
    return res.status(500).json({ ok: false, error: "probe failed" });
  }
});

// --- TEMP PROBE: inspect session table & matching logic (no auth) ---
r.get("/__probe_guard", async (req, res) => {
  try {
    const auth = String(req.headers["authorization"] || "");
    const m = /^Bearer\s+(.+)$/.exec(auth);
    const token = m ? m[1].trim() : null;

    const sessionTbl = await detectSessionTable();

    // Show a few raw rows so we see the exact JSON keys
    const sample = await pool.query(
      `SELECT to_jsonb(s) AS row FROM ${sessionTbl} s LIMIT 3`
    );

    // Try the same predicate our guard uses
    const byJson = await pool.query(
      `SELECT to_jsonb(s) AS row
         FROM ${sessionTbl} s
        WHERE to_jsonb(s)->>'token' = $1
        LIMIT 1`,
      [token]
    );

    res.json({
      sessionTbl,
      tokenPreview: token ? token.slice(0, 8) : null,
      sample: sample.rows?.map(r => r.row) ?? [],
      matchWithJsonArrow: {
        found: !!byJson.rows?.length,
        row: byJson.rows?.[0]?.row ?? null,
      },
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});


// --- DEBUG PROBE: inspect auth state without blocking (remove after debugging) ---
r.get("/__probe_auth", async (req, res) => {
  try {
    const auth = String(req.headers["authorization"] || "");
    const m = /^Bearer\s+(.+)$/.exec(auth);
    if (!m) return res.status(200).json({ ok: false, why: "no-bearer" });
    const token = m[1].trim();
    const tok8 = token.slice(0, 8);

    const qPub = `SELECT "id","partnerId","token","expiresAt","revokedAt"
                  FROM public."ExtranetSession" WHERE "token" = $1 LIMIT 1`;
    const r1 = await pool.query(qPub, [token]);

    let tbl = `public."ExtranetSession"`;
    let row: any = r1.rows?.[0];

    if (!row) {
      const qExt = `SELECT "id","partnerId","token","expiresAt","revokedAt"
                    FROM extranet."ExtranetSession" WHERE "token" = $1 LIMIT 1`;
      const r2 = await pool.query(qExt, [token]);
      row = r2.rows?.[0];
      tbl = `extranet."ExtranetSession"`;
    }

    if (!row) {
      return res.status(200).json({
        ok: false,
        why: "no-row",
        tokenPreview: tok8,
        checked: [`public."ExtranetSession"`, `extranet."ExtranetSession"`],
      });
    }

    const expired = isExpired(row.expiresAt);
    const revoked = !!row.revokedAt;

    return res.status(200).json({
      ok: !expired && !revoked,
      tokenPreview: tok8,
      sessionTbl: tbl,
      row,
      checks: { expired, revoked },
    });
  } catch (e: any) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
});

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
