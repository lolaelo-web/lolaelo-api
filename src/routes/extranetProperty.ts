// src/routes/extranetProperty.ts
import { Router } from "express";
import { Pool } from "pg";
import requirePartner from "./extranetAuth.js"; // <-- reuse the working guard

const r = Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- DB objects ---
const TBL_PROFILE = `extranet."PropertyProfile"`;

/** Helper: tiny sanitizer -> returns null for empty strings */
function nz(v: unknown) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

// All routes below require a valid partner session
r.use(requirePartner);

/** GET /extranet/property */
r.get("/", async (req: any, res) => {
  const partnerId = req.partner?.id;
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

/** PUT /extranet/property */
r.put("/", async (req: any, res) => {
  const partnerId = req.partner?.id;
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
