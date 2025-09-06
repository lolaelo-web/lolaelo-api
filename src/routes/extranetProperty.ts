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

/** Safe date check */
function isExpired(expiresAt: unknown): boolean {
  if (!expiresAt) return false;
  const t = new Date(expiresAt as any).getTime();
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

/** Cache for detected session table */
let SESSION_TBL_CACHED: string | null = null;

/** Find a table in schema `extranet` with columns token, partnerId, expiresAt (and optionally email, name) */
async function detectSessionTable(): Promise<string> {
  if (SESSION_TBL_CACHED) return SESSION_TBL_CACHED;

  const { rows } = await pool.query(
    `
    WITH cols AS (
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'extranet'
        AND column_name IN ('token','partnerId','expiresAt','email','name')
    )
    SELECT table_name
    FROM cols
    GROUP BY table_name
    HAVING COUNT(*) FILTER (WHERE column_name = 'token') > 0
       AND COUNT(*) FILTER (WHERE column_name = 'partnerId') > 0
       AND COUNT(*) FILTER (WHERE column_name = 'expiresAt') > 0
    ORDER BY table_name
    `
  );
  if (!rows.length) {
    throw new Error("No session table with token/partnerId/expiresAt found in schema extranet");
  }
  const t = rows[0].table_name;
  SESSION_TBL_CACHED = `extranet."${t}"`;
  return SESSION_TBL_CACHED;
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
    if (!m) return res.status(401).json({ error: "unauthorized" });
    const token = m[1].trim();

    const sessionTbl = await detectSessionTable();

    const { rows } = await pool.query(
      `SELECT "partnerId", 
              COALESCE(NULLIF((to_jsonb(s)->>'email'),'null'), NULL) AS "email",
              COALESCE(NULLIF((to_jsonb(s)->>'name'),'null'), NULL)  AS "name",
              "expiresAt"
         FROM ${sessionTbl} s
        WHERE "token" = $1
        LIMIT 1`,
      [token]
    );

    if (!rows.length) return res.status(401).json({ error: "unauthorized" });

    const s = rows[0] as {
      partnerId: number;
      email: string | null;
      name: string | null;
      expiresAt: string | Date | null;
    };

    if (isExpired(s.expiresAt)) return res.status(401).json({ error: "unauthorized" });

    req.partner = {
      id: Number(s.partnerId),
      email: s.email ?? undefined,
      name: s.name ?? undefined,
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
