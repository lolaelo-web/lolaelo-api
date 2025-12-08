// src/routes/extranetProperty.ts
import { Router, Request, Response, NextFunction } from "express";
import { Pool } from "pg";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";

const r = Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- DB objects --- no more public schema ---
const TBL_PROFILE = `extranet."PropertyProfile"`;
const TBL_DOC     = `extranet."PropertyDocument"`;
const TBL_PHOTO   = `extranet."PropertyPhoto"`;
const TBL_ADDON   = `extranet."AddOn"`;

// --- S3 helpers (for document/photo hard-delete) ---
const s3Region =
  process.env.AWS_REGION || process.env.S3_REGION || "us-east-1";
const s3AccessKeyId =
  process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID || "";
const s3SecretAccessKey =
  process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY || "";

const s3 = new S3Client({
  region: s3Region,
  credentials:
    s3AccessKeyId && s3SecretAccessKey
      ? { accessKeyId: s3AccessKeyId, secretAccessKey: s3SecretAccessKey }
      : undefined,
});

function docsBucket() {
  return (
    process.env.DOCS_BUCKET ||
    process.env.S3_BUCKET_DOCS ||
    process.env.S3_BUCKET ||
    process.env.PHOTOS_BUCKET ||
    ""
  );
}

// --- Photo upload constraints ---
const PHOTOS_MAX_BYTES = Number(process.env.PHOTOS_MAX_BYTES || 12 * 1024 * 1024); // 12 MB default
const PHOTOS_ALLOWED_CT = String(process.env.PHOTOS_ALLOWED_CT || "image/jpeg,image/png,image/webp")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

function photosBucket() {
  return (
    process.env.PHOTOS_BUCKET ||
    process.env.S3_BUCKET ||
    process.env.DOCS_BUCKET ||
    ""
  );
}

// --- Document upload constraints ---
const DOCS_MAX_BYTES = Number(process.env.DOCS_MAX_BYTES || 10 * 1024 * 1024); // 10 MB default
const DOCS_ALLOWED_CT = String(process.env.DOCS_ALLOWED_CT || "application/pdf,image/png,image/jpeg,text/plain")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

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

// ---- Auth guard: Bearer <UUID token>, validated against extranet.ExtranetSession VIEW ----
async function requirePartner(
  req: Request & { partner?: { id: number; email?: string; name?: string } },
  res: Response,
  next: NextFunction
) {
  try {
    // 1) Extract bearer token
    const auth = String(req.headers["authorization"] || "");
    const m = /^Bearer\s+(.+)$/.exec(auth);
    let token = m ? m[1].trim() : "";
    if (!token) {
      token = String(req.headers["x-partner-token"] || "").trim();
      if (!token) {
        console.log("[property:auth] no token (Authorization or x-partner-token)");
        return res.status(401).json({ error: "unauthorized" });
      }
    }
    console.log("[property:auth] bearer prefix:", token.slice(0, 8));

    // 2) Lookup in extranet view
    const row = await getSessionRow(token);
    if (!row) return res.status(401).json({ error: "unauthorized" });
    if (row.revokedAt) return res.status(401).json({ error: "unauthorized" });
    if (isExpired(row.expiresAt)) return res.status(401).json({ error: "unauthorized" });

    // 3) Attach partner context
    req.partner = { id: Number(row.partnerId) };
    return next();
  } catch (e) {
    console.error("[property:auth] error", e);
    return res.status(401).json({ error: "unauthorized" });
  }
}

// --- Debug probes: only enabled outside production ---
if (process.env.NODE_ENV !== "production") {
  // JSONB-only probe (legacy structures)
  r.get("/__probe_session", async (req, res) => {
    try {
      const auth = String(req.headers["authorization"] || "");
      const m = /^Bearer\s+(.+)$/.exec(auth);
      if (!m) return res.status(401).json({ ok: false, error: "unauthorized" });
      const token = m[1].trim();

      const sessionTbl = `extranet."ExtranetSession"`;
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

  // Table sample + match check
  r.get("/__probe_guard", async (req, res) => {
    try {
      const auth = String(req.headers["authorization"] || "");
      const m = /^Bearer\s+(.+)$/.exec(auth);
      const token = m ? m[1].trim() : null;

      const sessionTbl = `extranet."ExtranetSession"`;

      const sample = await pool.query(
        `SELECT to_jsonb(s) AS row FROM ${sessionTbl} s LIMIT 3`
      );

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

  // Auth probe for quick diagnosis (extranet-only)
  r.get("/__probe_auth", async (req, res) => {
    try {
      const auth = String(req.headers["authorization"] || "");
      const m = /^Bearer\s+(.+)$/.exec(auth);
      if (!m) return res.status(200).json({ ok: false, why: "no-bearer" });
      const token = m[1].trim();
      const tok8 = token.slice(0, 8);

      const sessionTbl = `extranet."ExtranetSession"`;
      const qExt = `SELECT "id","partnerId","token","expiresAt","revokedAt"
                    FROM extranet."ExtranetSession" WHERE "token" = $1 LIMIT 1`;
      const r1 = await pool.query(qExt, [token]);
      const row: any = r1.rows?.[0];

      if (!row) {
        return res.status(200).json({
          ok: false,
          why: "no-row",
          tokenPreview: tok8,
          checked: [sessionTbl],
        });
      }

      const expired = isExpired(row.expiresAt);
      const revoked = !!row.revokedAt;

      return res.status(200).json({
        ok: !expired && !revoked,
        tokenPreview: tok8,
        sessionTbl,
        row,
        checks: { expired, revoked },
      });
    } catch (e: any) {
      return res.status(200).json({ ok: false, error: String(e?.message || e) });
    }
  });
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
              "addressLine","city","cityCode","latitude","longitude",
              "description","mapLabel","updatedAt","createdAt"
         FROM ${TBL_PROFILE}
        WHERE "partnerId" = $1`,
      [partnerId]
    );

    if (!rows.length) {
      return res.json({
        partnerId,
        name: null,
        contactEmail: null,
        phone: null,
        country: null,
        addressLine: null,
        city: null,
        cityCode: null,
        latitude: null,
        longitude: null,
        description: null,
        mapLabel: null,
        createdAt: null,
        updatedAt: null,
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
  const KEYS = [
    "name",
    "contactEmail",
    "phone",
    "country",
    "addressLine",
    "city",
    "cityCode",
    "latitude",
    "longitude",
    "description",
    "mapLabel",
  ];

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
    cityCode:     payload.cityCode,
    latitude:     payload.latitude,
    longitude:    payload.longitude,
    description:  payload.description,
    mapLabel:     payload.mapLabel,
  });

  if (!data.name || typeof data.name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  try {
    // Pre-image for audit
    const { rows: wasRows } = await pool.query(
      `SELECT "partnerId","name","contactEmail","phone","country",
              "addressLine","city","cityCode","latitude","longitude",
              "description","mapLabel","updatedAt","createdAt"
         FROM ${TBL_PROFILE}
        WHERE "partnerId" = $1
        LIMIT 1`,
      [partnerId]
    );

    const { rows } = await pool.query(
      `INSERT INTO ${TBL_PROFILE}
         ("partnerId","name","contactEmail","phone","country",
          "addressLine","city","cityCode","latitude","longitude",
          "description","mapLabel","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW(), NOW())
       ON CONFLICT ("partnerId") DO UPDATE
           SET "name"         = EXCLUDED."name",
               "contactEmail" = EXCLUDED."contactEmail",
               "phone"        = EXCLUDED."phone",
               "country"      = EXCLUDED."country",
               "addressLine"  = EXCLUDED."addressLine",
               "city"         = EXCLUDED."city",
               "cityCode"     = EXCLUDED."cityCode",
               "latitude"     = EXCLUDED."latitude",
               "longitude"    = EXCLUDED."longitude",
               "description"  = EXCLUDED."description",
               "mapLabel"     = EXCLUDED."mapLabel",
               "updatedAt"    = NOW()
       RETURNING "partnerId","name","contactEmail","phone","country",
                 "addressLine","city","cityCode","latitude","longitude",
                 "description","mapLabel","updatedAt","createdAt"`,
      [
        partnerId,
        data.name,
        data.contactEmail,
        data.phone,
        data.country,
        data.addressLine,
        data.city,
        data.cityCode,
        data.latitude,
        data.longitude,
        data.description,
        data.mapLabel,
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
  const allowed = new Set([
    "name",
    "contactEmail",
    "phone",
    "country",
    "addressLine",
    "city",
    "cityCode",
    "latitude",
    "longitude",
    "description",
    "mapLabel",
  ]);
  const incoming: Record<string, any> = {};
  for (const [k, v] of Object.entries(req.body ?? {})) {
    if (allowed.has(k)) incoming[k] = v;
  }

  const patchData = norm(incoming);

  try {
    // Read current (if any) — also used as audit pre-image
    const { rows: curRows } = await pool.query(
      `SELECT "partnerId","name","contactEmail","phone","country",
              "addressLine","city","cityCode","latitude","longitude",
              "description","mapLabel","updatedAt","createdAt"
         FROM ${TBL_PROFILE}
        WHERE "partnerId" = $1
        LIMIT 1`,
      [partnerId]
    );

    const curr:
      | {
          partnerId: number;
          name: string | null;
          contactEmail: string | null;
          phone: string | null;
          country: string | null;
          addressLine: string | null;
          city: string | null;
          cityCode: string | null;
          latitude: number | null;
          longitude: number | null;
          description: string | null;
          mapLabel: string | null;
          createdAt: Date | null;
          updatedAt: Date | null;
        }
      | undefined = curRows[0];

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
      cityCode:     Object.prototype.hasOwnProperty.call(patchData, "cityCode") ? patchData.cityCode : (curr?.cityCode ?? null),
      latitude:     Object.prototype.hasOwnProperty.call(patchData, "latitude") ? patchData.latitude : (curr?.latitude ?? null),
      longitude:    Object.prototype.hasOwnProperty.call(patchData, "longitude") ? patchData.longitude : (curr?.longitude ?? null),
      description:  Object.prototype.hasOwnProperty.call(patchData, "description") ? patchData.description : (curr?.description ?? null),
      mapLabel:     Object.prototype.hasOwnProperty.call(patchData, "mapLabel") ? patchData.mapLabel : (curr?.mapLabel ?? null),
    };

    // Upsert merged state
    const { rows } = await pool.query(
      `INSERT INTO ${TBL_PROFILE}
         ("partnerId","name","contactEmail","phone","country",
          "addressLine","city","cityCode","latitude","longitude",
          "description","mapLabel","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW(), NOW())
       ON CONFLICT ("partnerId") DO UPDATE
           SET "name"         = EXCLUDED."name",
               "contactEmail" = EXCLUDED."contactEmail",
               "phone"        = EXCLUDED."phone",
               "country"      = EXCLUDED."country",
               "addressLine"  = EXCLUDED."addressLine",
               "city"         = EXCLUDED."city",
               "cityCode"     = EXCLUDED."cityCode",
               "latitude"     = EXCLUDED."latitude",
               "longitude"    = EXCLUDED."longitude",
               "description"  = EXCLUDED."description",
               "mapLabel"     = EXCLUDED."mapLabel",
               "updatedAt"    = NOW()
       RETURNING "partnerId","name","contactEmail","phone","country",
                 "addressLine","city","cityCode","latitude","longitude",
                 "description","mapLabel","updatedAt","createdAt"`,
      [
        partnerId,
        next.name,
        next.contactEmail,
        next.phone,
        next.country,
        next.addressLine,
        next.city,
        next.cityCode,
        next.latitude,
        next.longitude,
        next.description,
        next.mapLabel,
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
    return res.status(500).json({ error: "Property save failed" });
  }
});

/** GET /extranet/property/addons -> list add-ons for current partner */
r.get("/addons", async (req, res) => {
  const partnerId = (req as any)?.partner?.id;
  if (!partnerId) return res.status(401).json({ error: "unauthorized" });

  res.set("Cache-Control", "no-store, no-cache, must-revalidate");

  try {
    const { rows } = await pool.query(
      `SELECT "id","partnerId","activity","uom","price","notes",
              "active","sortOrder","maxQty","createdAt","updatedAt"
         FROM ${TBL_ADDON}
        WHERE "partnerId" = $1
        ORDER BY COALESCE("sortOrder", 9999), "id"`,
      [partnerId]
    );
    return res.json(rows);
  } catch (e) {
    console.error("[addons:list] db error", e);
    return res.status(500).json({ error: "Add-ons list failed" });
  }
});

/**
 * PUT /extranet/property/addons
 * Bulk-replace all add-ons for the current partner.
 * Body: { items: [{ activity, uom, price, notes }] }
 */
r.put("/addons", async (req, res) => {
  const partnerId = (req as any)?.partner?.id;
  if (!partnerId) return res.status(401).json({ error: "unauthorized" });

  const body = (req.body ?? {}) as any;
  const items = Array.isArray(body.items) ? body.items : [];

  // Normalize and validate incoming rows
  const cleaned = items
    .map((raw: any, idx: number) => {
      const activity = String(raw.activity ?? "").trim();
      const uom      = raw.uom != null ? String(raw.uom).trim() : "";
      const notes    = raw.notes != null ? String(raw.notes).trim() : "";
      const priceNum = typeof raw.price === "number"
        ? raw.price
        : Number(raw.price ?? NaN);

      if (!activity) return null;

      const price =
        Number.isFinite(priceNum) && priceNum >= 0 ? priceNum : null;

      return {
        activity,
        uom: uom || null,
        price,
        notes: notes || null,
        sortOrder: idx + 1,
      };
    })
    .filter(Boolean) as {
      activity: string;
      uom: string | null;
      price: number | null;
      notes: string | null;
      sortOrder: number;
    }[];

  try {
    await pool.query("BEGIN");

    // Wipe existing add-ons for this partner
    await pool.query(
      `DELETE FROM ${TBL_ADDON} WHERE "partnerId" = $1`,
      [partnerId]
    );

    // Insert new set (if any)
    for (const row of cleaned) {
      await pool.query(
        `INSERT INTO ${TBL_ADDON}
           ("partnerId","activity","uom","price","notes",
            "active","sortOrder","maxQty","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,true,$6,NULL,NOW(),NOW())`,
        [
          partnerId,
          row.activity,
          row.uom,
          row.price,
          row.notes,
          row.sortOrder,
        ]
      );
    }

    await pool.query("COMMIT");

    // Return fresh list
    const { rows } = await pool.query(
      `SELECT "id","partnerId","activity","uom","price","notes",
              "active","sortOrder","maxQty","createdAt","updatedAt"
         FROM ${TBL_ADDON}
        WHERE "partnerId" = $1
        ORDER BY COALESCE("sortOrder", 9999), "id"`,
      [partnerId]
    );

    return res.json(rows);
  } catch (e) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("[addons:put] db error", e);
    return res.status(500).json({ error: "Add-ons save failed" });
  }
});

/** GET /extranet/property/photos -> list photos for current partner */
r.get("/photos", async (req, res) => {
  const partnerId = (req as any)?.partner?.id;
  if (!partnerId) return res.status(401).json({ error: "unauthorized" });

  res.set("Cache-Control", "no-store, no-cache, must-revalidate");

  try {
    const { rows } = await pool.query(
      `SELECT "id","key","url","alt","sortOrder","isCover","width","height","createdAt","roomTypeId"
         FROM ${TBL_PHOTO}
        WHERE "partnerId" = $1
        ORDER BY "isCover" DESC, "sortOrder" ASC, "id" ASC`,
      [partnerId]
    );
    return res.json({ value: rows, Count: rows.length });
  } catch (e) {
    console.error("[property:photos:list] db error", e);
    return res.status(500).json({ error: "Photos fetch failed" });
  }
});

/**
 * POST /extranet/property/photos/upload-url
 * Body: { fileName: string, contentType: string, size: number }
 */
r.post("/photos/upload-url", async (req, res) => {
  const partnerId = (req as any)?.partner?.id;
  if (!partnerId) return res.status(401).json({ error: "unauthorized" });

  const { fileName, contentType, size } = (req.body ?? {}) as { fileName?: string; contentType?: string; size?: number; };
  if (!fileName || !contentType || (size == null)) {
    return res.status(400).json({ error: "fileName, contentType, size are required" });
  }
  const sz = Number(size);
  if (!Number.isFinite(sz) || sz <= 0 || sz > PHOTOS_MAX_BYTES) {
    return res.status(413).json({ error: "File too large", maxBytes: PHOTOS_MAX_BYTES });
  }
  const ct = String(contentType).toLowerCase();
  if (!PHOTOS_ALLOWED_CT.includes(ct)) {
    return res.status(415).json({ error: "Unsupported content type", allowed: PHOTOS_ALLOWED_CT });
  }

  // Key: <PHOTOS_PREFIX>/<partnerId>/<uuid>-<safeName>
  const prefix = (process.env.PHOTOS_PREFIX || "photos/gallery").replace(/^\/+|\/+$/g, "");
  const safeName = String(fileName).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-120);
  let uuid: string;
  try { uuid = require("crypto").randomUUID(); } catch { uuid = Math.random().toString(36).slice(2); }
  const key = `${prefix}/${partnerId}/${uuid}-${safeName}`;

  const Bucket = photosBucket();
  const region =
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    process.env.S3_REGION || "us-east-1";
  const accessKey =
    process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID;
  const secretKey =
    process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY;

  if (!Bucket) return res.status(501).json({ error: "photos bucket not configured" });
  if (!(accessKey && secretKey) && !process.env.AWS_PROFILE) {
    return res.status(501).json({ error: "upload signing not configured (missing AWS/S3 credentials)" });
  }

  // Dynamic import (match documents endpoint pattern)
  let S3ClientDyn: any, PutObjectCommand: any, getSignedUrl: any;
  try {
    const s3mod = await import("@aws-sdk/client-s3");
    const pres  = await import("@aws-sdk/s3-request-presigner");
    S3ClientDyn = s3mod.S3Client;
    PutObjectCommand = s3mod.PutObjectCommand;
    getSignedUrl = pres.getSignedUrl;
  } catch (e) {
    console.error("[photos:upload-url] import error", e);
    return res.status(501).json({ error: "missing @aws-sdk packages" });
  }

  try {
    const s3dyn = new S3ClientDyn({
      region,
      credentials: (accessKey && secretKey) ? { accessKeyId: accessKey, secretAccessKey: secretKey } : undefined,
    });
    const cmd = new PutObjectCommand({ Bucket, Key: key, ContentType: contentType, ACL: "private" });
    const uploadUrl = await getSignedUrl(s3dyn, cmd, { expiresIn: 600 });
    const publicBase =
      (process.env.PHOTOS_PUBLIC_BASE_URL ||
       process.env.S3_PUBLIC_BASE_URL ||
       `https://${Bucket}.s3.${region}.amazonaws.com`).replace(/\/+$/,"");
    const url = `${publicBase}/${key}`;
    return res.json({ key, url, uploadUrl, headers: { "Content-Type": contentType } });
  } catch (e) {
    console.error("[photos:upload-url] signing error", e);
    return res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/**
 * POST /extranet/property/photos
 * Body: { key, url, alt?, width?, height?, isCover?, roomTypeId? }
 */
r.post("/photos", async (req, res) => {
  const partnerId = (req as any)?.partner?.id;
  if (!partnerId) return res.status(401).json({ error: "unauthorized" });

  const {
    key,
    url,
    alt,
    width,
    height,
    isCover,
    roomTypeId,
  } = (req.body ?? {}) as any;

  if (!key || !url) {
    return res.status(400).json({ error: "key and url are required" });
  }

  try {
    // Next sortOrder = max + 1
    const nextSort = await pool.query(
      `SELECT COALESCE(MAX("sortOrder"),0)+1 AS n
         FROM ${TBL_PHOTO}
        WHERE "partnerId" = $1`,
      [partnerId]
    );
    const sortOrder = Number(nextSort.rows?.[0]?.n ?? 1);

    // If setting as cover, clear existing cover
    if (isCover === true) {
      await pool.query(
        `UPDATE ${TBL_PHOTO}
            SET "isCover" = FALSE
          WHERE "partnerId" = $1`,
        [partnerId]
      );
    }

    const { rows } = await pool.query(
      `INSERT INTO ${TBL_PHOTO}
         ("partnerId","key","url","alt","sortOrder","isCover","width","height","createdAt","roomTypeId")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW(), $9)
       RETURNING "id","key","url","alt","sortOrder","isCover","width","height","createdAt","roomTypeId"`,
      [
        partnerId,
        key,
        url,
        alt ?? null,
        sortOrder,
        !!isCover,
        Number(width) || null,
        Number(height) || null,
        Number.isFinite(Number(roomTypeId)) ? Number(roomTypeId) : null,
      ]
    );

    return res.json(rows[0]);
  } catch (e) {
    console.error("[property:photos:create] db error", e);
    return res.status(500).json({ error: "Photo create failed" });
  }
});

/** PUT /extranet/property/photos/:id  -> update alt, isCover, sortOrder, roomTypeId */
r.put("/photos/:id", async (req, res) => {
  const partnerId = (req as any)?.partner?.id;
  if (!partnerId) return res.status(401).json({ error: "unauthorized" });

  const id = Number(req.params.id) || 0;
  if (!id) return res.status(400).json({ error: "invalid id" });

  const { alt, isCover, sortOrder, roomTypeId } = (req.body ?? {}) as any;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Get current row so we can preserve roomTypeId when it is not sent
    const exists = await client.query(
      `SELECT "id","roomTypeId" FROM ${TBL_PHOTO} WHERE "id" = $1 AND "partnerId" = $2 LIMIT 1`,
      [id, partnerId]
    );
    if (!exists.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not found" });
    }

    let nextRoomTypeId: number | null = exists.rows[0].roomTypeId ?? null;
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "roomTypeId")) {
      // Field was sent; normalize it
      if (roomTypeId === null || roomTypeId === "") {
        nextRoomTypeId = null;
      } else {
        const n = Number(roomTypeId);
        nextRoomTypeId = Number.isFinite(n) ? n : null;
      }
    }

    // Update the target row
    const upd = await client.query(
      `UPDATE ${TBL_PHOTO}
          SET "alt"       = COALESCE($1, "alt"),
              "isCover"   = COALESCE($2, "isCover"),
              "sortOrder" = COALESCE($3, "sortOrder"),
              "roomTypeId"= $4
        WHERE "id" = $5 AND "partnerId" = $6
        RETURNING "id","key","url","alt","sortOrder","isCover","width","height","createdAt","roomTypeId"`,
      [
        alt ?? null,
        (isCover === undefined ? null : !!isCover),
        (sortOrder == null ? null : Number(sortOrder)),
        nextRoomTypeId,
        id,
        partnerId,
      ]
    );

    // If we've set this as the cover, clear others now (and only now)
    if (isCover === true) {
      await client.query(
        `UPDATE ${TBL_PHOTO}
            SET "isCover" = FALSE
          WHERE "partnerId" = $1 AND "id" <> $2`,
        [partnerId, id]
      );
    }

    await client.query("COMMIT");
    return res.json(upd.rows[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[photos:update] db error", e);
    return res.status(500).json({ error: "Photo update failed" });
  } finally {
    client.release();
  }
});

/** DELETE /extranet/property/photos/:id */
r.delete("/photos/:id", async (req, res) => {
  const partnerId = (req as any)?.partner?.id;
  if (!partnerId) return res.status(401).json({ error: "unauthorized" });

  const id = Number(req.params.id) || 0;
  if (!id) return res.status(400).json({ error: "invalid id" });

  try {
    const { rows } = await pool.query(
      `SELECT "id","key" FROM ${TBL_PHOTO} WHERE "id" = $1 AND "partnerId" = $2 LIMIT 1`,
      [id, partnerId]
    );
    if (!rows.length) return res.status(404).json({ error: "not found" });

    const key: string | null = rows[0].key ?? null;

    // Best-effort S3 delete
    try {
      const Bucket = photosBucket();
      if (Bucket && key) {
        await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
      }
    } catch (err) {
      console.error("[photos:delete] S3 DeleteObject failed:", err);
    }

    await pool.query(
      `DELETE FROM ${TBL_PHOTO} WHERE "id" = $1 AND "partnerId" = $2`,
      [id, partnerId]
    );
    return res.status(204).end();
  } catch (e) {
    console.error("[photos:delete] db error", e);
    return res.status(500).json({ error: "Photo delete failed" });
  }
});

/** GET /extranet/property/documents -> list documents for current partner */
r.get("/documents", async (req, res) => {
  const partnerId = (req as any)?.partner?.id;
  if (!partnerId) return res.status(401).json({ error: "unauthorized" });

  res.set("Cache-Control", "no-store, no-cache, must-revalidate");

  try {
    const { rows } = await pool.query(
      `SELECT "id","partnerId","type","key","url","fileName","contentType",
              "status","uploadedAt","verifiedAt","expiresAt","notes"
         FROM ${TBL_DOC}
        WHERE "partnerId" = $1
        ORDER BY "uploadedAt" DESC, "id" DESC`,
      [partnerId]
    );
    return res.json({ value: rows, Count: rows.length });
  } catch (e) {
    console.error("[property:documents:list] db error", e);
    return res.status(500).json({ error: "Documents fetch failed" });
  }
});

/** GET /extranet/property/documents/types -> enum values for DocumentType */
r.get("/documents/types", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.enumlabel AS value
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'extranet' AND t.typname = 'DocumentType'
      ORDER BY e.enumsortorder
    `);
    const values = rows.map(r => r.value);
    return res.json({ value: values, Count: values.length });
  } catch (e) {
    console.error("[property:documents:types] db error", e);
    return res.status(500).json({ error: "Document types fetch failed" });
  }
});

/**
 * POST /extranet/property/documents/upload-url
 * Body: { fileName: string, contentType: string, size?: number }
 * Returns a presigned S3 URL when AWS/S3 env is configured; otherwise 501.
 */
r.post("/documents/upload-url", async (req, res) => {
  const partnerId = (req as any)?.partner?.id;
  if (!partnerId) return res.status(401).json({ error: "unauthorized" });

  const { fileName, contentType, size } = (req.body ?? {}) as {
    fileName?: string; contentType?: string; size?: number;
  };
  if (!fileName || !contentType || (size == null)) {
    return res.status(400).json({ error: "fileName, contentType, size are required" });
  }
  const sz = Number(size);
  if (!Number.isFinite(sz) || sz <= 0 || sz > DOCS_MAX_BYTES) {
    return res.status(413).json({ error: "File too large", maxBytes: DOCS_MAX_BYTES });
  }
  const ct = String(contentType).toLowerCase();
  if (!DOCS_ALLOWED_CT.includes(ct)) {
    return res.status(415).json({ error: "Unsupported content type", allowed: DOCS_ALLOWED_CT });
  }

  // Key: <DOCS_PREFIX>/<partnerId>/<uuid>-<sanitizedName>
  const prefix   = (process.env.DOCS_PREFIX || "docs").replace(/^\/+|\/+$/g, "");
  const safeName = String(fileName).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-120);
  let uuid: string;
  try { uuid = require("crypto").randomUUID(); } catch { uuid = Math.random().toString(36).slice(2); }
  const key = `${prefix}/${partnerId}/${uuid}-${safeName}`;

  // Env (supports AWS_* or S3_*); bucket defaults to your existing photos bucket if not overridden
  const bucket =
    process.env.DOCS_BUCKET ||
    process.env.S3_BUCKET_DOCS ||
    process.env.S3_BUCKET ||
    process.env.PHOTOS_BUCKET ||
    "lolaelo-photos-prod";

  const region =
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    process.env.S3_REGION ||
    "us-east-1";

  const accessKey =
    process.env.AWS_ACCESS_KEY_ID ||
    process.env.S3_ACCESS_KEY_ID;

  const secretKey =
    process.env.AWS_SECRET_ACCESS_KEY ||
    process.env.S3_SECRET_ACCESS_KEY;

  const publicBase =
    (process.env.DOCS_PUBLIC_BASE_URL ||
     process.env.S3_PUBLIC_BASE_URL ||
     `https://${bucket}.s3.${region}.amazonaws.com`).replace(/\/+$/,"");

  // Ensure credentials exist
  const hasCreds = !!(accessKey && secretKey) || !!process.env.AWS_PROFILE;
  if (!hasCreds) {
    return res.status(501).json({
      error: "upload signing not configured (missing AWS/S3 credentials)",
      needsEnv: [
        "AWS_ACCESS_KEY_ID or S3_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY or S3_SECRET_ACCESS_KEY",
        "AWS_REGION or S3_REGION",
      ],
    });
  }

  // Dynamic ESM import (Node 20+)
  let S3ClientDyn: any, PutObjectCommand: any, getSignedUrl: any;
  try {
    const s3mod = await import("@aws-sdk/client-s3");
    const pres  = await import("@aws-sdk/s3-request-presigner");
    S3ClientDyn = s3mod.S3Client;
    PutObjectCommand = s3mod.PutObjectCommand;
    getSignedUrl = pres.getSignedUrl;
  } catch (e) {
    console.error("[documents:upload-url] import error", e);
    return res.status(501).json({
      error: "upload signing not configured (missing @aws-sdk packages)",
      needs: ["@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner"],
    });
  }

  try {
    const s3Local = new S3ClientDyn({
      region,
      credentials: (accessKey && secretKey)
        ? { accessKeyId: accessKey, secretAccessKey: secretKey }
        : undefined, // allow default provider if AWS_* present
    });

    const cmd = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      ACL: "private",
      // ContentLength: size, // optional: enforce size if desired
    });

    const uploadUrl = await getSignedUrl(s3Local, cmd, { expiresIn: 600 }); // 10 min
    const url = `${publicBase}/${key}`;

    return res.json({
      key,
      url,            // public URL after upload
      uploadUrl,      // presigned PUT URL
      headers: { "Content-Type": contentType },
    });
  } catch (e) {
    console.error("[documents:upload-url] signing error", e);
    return res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/**
 * POST /extranet/property/documents
 * Body: { type: string, key: string, url: string, fileName: string, contentType: string, notes?: string }
 * Creates a new document row (multiple per type now allowed). Sets status SUBMITTED and uploadedAt NOW().
 */
r.post("/documents", async (req, res) => {
  const partnerId = (req as any)?.partner?.id;
  if (!partnerId) return res.status(401).json({ error: "unauthorized" });

  const { type, key, url, fileName, contentType, notes } = (req.body ?? {}) as {
    type?: string; key?: string; url?: string; fileName?: string; contentType?: string; notes?: string;
  };

  const DOC_TYPES = [
    "GOVT_ID",
    "BUSINESS_REG",
    "TAX_ID",
    "BANK_PROOF",
    "PROOF_OF_ADDRESS",
    "INSURANCE_LIABILITY",
    "PROPERTY_OWNERSHIP",
    "LOCAL_LICENSE",
  ];

  if (!type || !DOC_TYPES.includes(type)) {
    return res.status(400).json({ error: "invalid or missing type", allowed: DOC_TYPES });
  }
  if (!key || !url || !fileName || !contentType) {
    return res.status(400).json({ error: "key, url, fileName, contentType are required" });
  }

  const n = (v: any) => (typeof v === "string" ? (v.trim() || null) : v);

  try {
    const { rows } = await pool.query(
      `
      INSERT INTO ${TBL_DOC}
        ("partnerId","type","key","url","fileName","contentType","status","uploadedAt","notes")
      VALUES ($1,$2,$3,$4,$5,$6,'SUBMITTED', NOW(), $7)
      RETURNING
        "id","partnerId","type","key","url","fileName","contentType",
        "status","uploadedAt","verifiedAt","expiresAt","notes"
      `,
      [partnerId, type, n(key), n(url), n(fileName), n(contentType), n(notes)]
    );

    return res.json(rows[0]);
  } catch (e) {
    console.error("[documents:create] db error", e);
    return res.status(500).json({ error: "Document save failed" });
  }
});

/** PUT /extranet/property/documents/:id  -> update notes */
r.put("/documents/:id", async (req, res) => {
  const partnerId = (req as any)?.partner?.id;
  if (!partnerId) return res.status(401).json({ error: "unauthorized" });

  const id = Number(req.params.id) || 0;
  if (!id) return res.status(400).json({ error: "invalid id" });

  const { notes } = (req.body ?? {}) as { notes?: string };
  const n = (v: any) => (typeof v === "string" ? (v.trim() || null) : v);

  try {
    const { rowCount, rows } = await pool.query(
      `
      UPDATE ${TBL_DOC}
         SET "notes" = $1
       WHERE "id" = $2 AND "partnerId" = $3
       RETURNING "id","partnerId","type","key","url","fileName","contentType",
                 "status","uploadedAt","verifiedAt","expiresAt","notes"
      `,
      [n(notes), id, partnerId]
    );
    if (!rowCount) return res.status(404).json({ error: "not found" });
    return res.json(rows[0]);
  } catch (e) {
    console.error("[documents:update] db error", e);
    return res.status(500).json({ error: "Document update failed" });
  }
});

/** DELETE /extranet/property/documents/:id */
r.delete("/documents/:id", async (req, res) => {
  const partnerId = (req as any)?.partner?.id;
  if (!partnerId) return res.status(401).json({ error: "unauthorized" });

  const id = Number(req.params.id) || 0;
  if (!id) return res.status(400).json({ error: "invalid id" });

  try {
    // Fetch to get the S3 key
    const { rows } = await pool.query(
      `SELECT "id","key" FROM ${TBL_DOC} WHERE "id" = $1 AND "partnerId" = $2 LIMIT 1`,
      [id, partnerId]
    );
    if (!rows.length) return res.status(404).json({ error: "not found" });

    const key: string | null = rows[0].key ?? null;

    // Best-effort S3 delete (non-fatal if it fails or bucket not configured)
    try {
      const Bucket = docsBucket();
      if (Bucket && key) {
        await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
      }
    } catch (err) {
      console.error("[documents:delete] S3 DeleteObject failed:", err);
    }

    await pool.query(
      `DELETE FROM ${TBL_DOC} WHERE "id" = $1 AND "partnerId" = $2`,
      [id, partnerId]
    );
    return res.status(204).end();
  } catch (e) {
    console.error("[documents:delete] db error", e);
    return res.status(500).json({ error: "Document delete failed" });
  }
});

export default r;
