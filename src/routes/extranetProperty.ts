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
const TBL_SESSION = `extranet."PartnerSession"`;

/** Helper: returns null for empty strings */
function nz(v: unknown) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

/** Safe date check */
function isExpired(expiresAt: unknown): boolean {
  if (!expiresAt) return false;
  const t = new Date(expiresAt as any).getTime();
  return !Number.isFinite(t) || t <= Date.now();
}

// ---- Auth guard: Bearer <UUID token> validated against PartnerSession ----
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

    const { rows } = await pool.query(
      `SELECT "partnerId","email","name","expiresAt"
         FROM ${TBL_SESSION}
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

/** PUT /extranet/property  -> upsert the partner’s profile */
r.put("/", async (req, res) => {
  const partnerId = (req as any)?.partner?.id;
  if (!partnerId) return res.status(401).json({ error: "unauthorized" });

  res.set("Cache-Control", "no-store, no-cache, must-revalidate");

  const payload = req.body ?? {};
  const name         = nz(payload.name);
  const contactEmail = nz(payload.contactEmail);
  const phone        = nz(payload.phone);
  const country      = nz(payload.country);
  const addressLine  = nz(payload.addressLine);
  const city         = nz(payload.city);
  const description  = nz(payload.description);

  if (!name) return res.status(400).json({ error: "name is required" });

  try {
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
      [partnerId, name, contactEmail, phone, country, addressLine, city, description]
    );

    return res.json(rows[0]);
  } catch (e) {
    console.error("[property:put] db error", e);
    return res.status(500).json({ error: "Property save failed" });
  }
});

export default r;
