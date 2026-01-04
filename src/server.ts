// src/server.ts
import "dotenv/config";
import express, { type Router, type Request, type Response, type NextFunction } from "express";
import cors, { type CorsOptions } from "cors";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import { requireWriteToken } from "./middleware/requireWriteToken.js";
import Stripe from "stripe";
import crypto from "node:crypto";
import PDFDocument from "pdfkit";
import path from "path";
import fs from "fs";
import { sendBookingEmail } from "./mailer.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable("x-powered-by");

// === RATE PLANS (DB-backed) ===
type RPKind = "NONE" | "PERCENT" | "ABSOLUTE";

function wantsSSL(cs: string): boolean {
  return /\bsslmode=require\b/i.test(cs) || /render\.com/i.test(cs);
}

function num(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ANCHOR: REQUIRE_PARTNER_ID_FROM_REQUEST
function requirePartnerIdFromRequest(req: Request): number {
  // Temporary until real partner auth is wired.
  // Priority:
  // 1) x-partner-id header (we will send this from the extranet UI)
  // 2) partnerId query
  // 3) propertyId query (legacy pattern used across the extranet today)
  const h = req.headers["x-partner-id"];
  const pid =
    Number(Array.isArray(h) ? h[0] : h || 0) ||
    Number((req.query as any)?.partnerId || 0) ||
    Number((req.query as any)?.propertyId || 0);

  if (!pid || !Number.isFinite(pid)) {
    throw new Error("partner_id_required");
  }
  return pid;
}
// ANCHOR: REQUIRE_PARTNER_ID_FROM_REQUEST END

// GET /extranet/property/rateplans?propertyId=2&roomTypeId=32
app.get("/extranet/property/rateplans", async (req: Request, res: Response) => {
  try {
    res.set("Cache-Control", "no-store");

    const partnerId = num((req.query as any)?.propertyId);
    const roomTypeId = num((req.query as any)?.roomTypeId);

    if (!partnerId || !roomTypeId) {
      return res.status(400).json({ error: "propertyId_and_roomTypeId_required" });
    }

    const cs = process.env.DATABASE_URL || "";
    if (!cs) throw new Error("DATABASE_URL missing");

    const client = new Client({
      connectionString: cs,
      ssl: wantsSSL(cs) ? { rejectUnauthorized: false } : undefined,
    });

    await client.connect();

    const { rows } = await client.query(
      `
      SELECT
        id,
        name,
        code,
        COALESCE("isDefault", FALSE) AS "isDefault",
        COALESCE(kind, 'NONE')       AS kind,
        COALESCE(value, 0)           AS value,
        COALESCE(active, TRUE)       AS active
      FROM extranet."RatePlan"
      WHERE "partnerId" = $1
        AND "roomTypeId" = $2
      ORDER BY
        COALESCE("isDefault", FALSE) DESC,
        id ASC
      `,
      [partnerId, roomTypeId]
    );

    await client.end();
    return res.json(rows);
  } catch (e) {
    console.error("rateplans GET db error:", e);
    return res.status(500).json({ error: "rateplans_get_failed" });
  }
});

// POST /extranet/property/rateplans?propertyId=2&roomTypeId=32
// Body: { plans: [{ code, active? , kind? , value? , name? }] }
app.post("/extranet/property/rateplans", express.json(), async (req: Request, res: Response) => {
  try {
    res.set("Cache-Control", "no-store");

    const body = req.body ?? {};

    // accept ids from either body OR query string (your UI posts via query string)
    const partnerId = num(body.propertyId ?? (req.query as any)?.propertyId);
    const roomTypeId = num(body.roomTypeId ?? (req.query as any)?.roomTypeId);

    const items = Array.isArray(body.plans) ? body.plans : [];
    if (!partnerId || !roomTypeId) {
      return res.status(400).json({ error: "propertyId_and_roomTypeId_required" });
    }
    if (!items.length) {
      return res.status(400).json({ error: "no_plans" });
    }

    const cs = process.env.DATABASE_URL || "";
    if (!cs) throw new Error("DATABASE_URL missing");

    const client = new Client({
      connectionString: cs,
      ssl: wantsSSL(cs) ? { rejectUnauthorized: false } : undefined,
    });

    await client.connect();

    // Update row-by-row by code (room scoped)
    for (const raw of items) {
      const code = String(raw?.code || "").toUpperCase().slice(0, 10);
      if (!code) continue;

      // Standard can remain editable for active, but if you want it locked:
      // if (code === "STD") continue;

      const hasActive = typeof raw?.active === "boolean";
      const hasKind = typeof raw?.kind === "string" && ["NONE", "PERCENT", "ABSOLUTE"].includes(String(raw.kind).toUpperCase());
      const hasValue = raw?.value != null && Number.isFinite(Number(raw.value));
      const hasName = typeof raw?.name === "string" && raw.name.trim().length > 0;

      // Only run UPDATE fields that were provided
      const sets: string[] = [];
      const vals: any[] = [partnerId, roomTypeId, code];
      let p = 4;

      if (hasActive) { sets.push(`active = $${p++}`); vals.push(!!raw.active); }
      if (hasKind)   { sets.push(`kind = $${p++}`);   vals.push(String(raw.kind).toUpperCase()); }
      if (hasValue)  { sets.push(`value = $${p++}`);  vals.push(Number(raw.value)); }
      if (hasName)   { sets.push(`name = $${p++}`);   vals.push(String(raw.name).trim().slice(0, 80)); }

      if (!sets.length) continue;

      const q = `
        UPDATE extranet."RatePlan"
        SET ${sets.join(", ")}
        WHERE "partnerId" = $1
          AND "roomTypeId" = $2
          AND UPPER(code) = $3
        RETURNING id, name, code, COALESCE("isDefault", FALSE) AS "isDefault",
                  COALESCE(kind, 'NONE') AS kind, COALESCE(value, 0) AS value, COALESCE(active, TRUE) AS active
      `;

      const updated = await client.query(q, vals);

      // If nothing updated (code not found), return explicit error (helps you debug fast)
      if (updated.rowCount === 0) {
        await client.end();
        return res.status(400).json({ error: "rateplan_code_not_found", code });
      }
    }

    // Return fresh list as source of truth
    const { rows } = await client.query(
      `
      SELECT
        id,
        name,
        code,
        COALESCE("isDefault", FALSE) AS "isDefault",
        COALESCE(kind, 'NONE')       AS kind,
        COALESCE(value, 0)           AS value,
        COALESCE(active, TRUE)       AS active
      FROM extranet."RatePlan"
      WHERE "partnerId" = $1
        AND "roomTypeId" = $2
      ORDER BY
        COALESCE("isDefault", FALSE) DESC,
        id ASC
      `,
      [partnerId, roomTypeId]
    );

    await client.end();
    return res.json({ ok: true, plans: rows });
  } catch (e) {
    console.error("rateplans POST db error:", e);
    return res.status(500).json({ error: "rateplans_post_failed" });
  }
});

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
// ---- Stripe webhook (verified) ----
// MUST be registered BEFORE express.json(), so req.body stays raw for signature verification
app.post("/api/payments/webhook", express.raw({ type: "application/json" }), async (req: Request, res: Response) => {
  const sig = req.headers["stripe-signature"] as string | undefined;
  if (!sig) return res.status(400).send("Missing Stripe signature");

  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET as string
    );
  } catch (err: any) {
    console.error("[WH] invalid signature:", err?.message || err);
    return res.status(400).send("Invalid signature");
  }

  if (event.type !== "checkout.session.completed") {
    return res.json({ received: true });
  }

  const session = event.data.object as Stripe.Checkout.Session;

  // DEBUG: confirm metadata contents
  const mdDbg: any = session.metadata || {};
  console.log("[WH] metadata keys:", Object.keys(mdDbg));
  console.log("[WH] metadata.addons len:", mdDbg.addons ? String(mdDbg.addons).length : 0);
  console.log("[WH] metadata.addonsSummary:", mdDbg.addonsSummary || "");

  const providerPaymentId = session.id;

  try {
    const cs = process.env.DATABASE_URL || "";
    if (!cs) throw new Error("DATABASE_URL missing");

    const client = new Client({
      connectionString: cs,
      ssl: wantsSSL(cs) ? { rejectUnauthorized: false } : undefined,
    });
    await client.connect();

    try {
      // Idempotent guard
      const exists = await client.query(
        `SELECT id FROM extranet."Booking" WHERE "providerPaymentId" = $1 LIMIT 1`,
        [providerPaymentId]
      );
      if (exists.rows.length) {
        await client.end();
        return res.json({ received: true });
      }

      const md = session.metadata || {};

      const addonsSummary =
        String(
          (md as any)?.addonsSummary ??
          (md as any)?.addOnsSummary ??
          (md as any)?.addons ??
          (md as any)?.addOns ??
          ""
        ).trim();

      // Accept either the new keys or the old ones (fallback)
      const partnerId  = Number(md.partnerId  || md.propertyId);
      const roomTypeId = Number(md.roomTypeId || md.roomId);
      const ratePlanId = Number(md.ratePlanId);
      const checkInDate  = md.checkInDate ? new Date(String(md.checkInDate) + "T00:00:00Z")
        : (md.start ? new Date(String(md.start) + "T00:00:00Z") : null);

      const checkOutDate = md.checkOutDate ? new Date(String(md.checkOutDate) + "T00:00:00Z")
        : (md.end ? new Date(String(md.end) + "T00:00:00Z") : null);
      const qty    = Number(md.qty || 1);
      const guests = Math.max(1, parseInt(String(md.guestsCount ?? md.guests ?? "1"), 10));

      if (!partnerId || !roomTypeId || !ratePlanId || !checkInDate || !checkOutDate) {
        console.error("[WH] missing metadata:", md);
        await client.end();
        return res.status(400).send("Missing booking metadata");
      }

      const now = new Date();
      const pendingConfirmExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const refundDeadlineAt        = new Date(pendingConfirmExpiresAt.getTime() + 48 * 60 * 60 * 1000);

      // Booking ref LL-XXXXXX
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let bookingRef = "LL-";
      for (let i = 0; i < 6; i++) bookingRef += chars[Math.floor(Math.random() * chars.length)];

      const md2 = session.metadata || {};
      console.log("[WH] guestsCount metadata:", md2.guestsCount, "guests:", md2.guests);

      const firstName =
        (md2.travelerFirstName && String(md2.travelerFirstName).trim()) ||
        null;

      const lastName =
        (md2.travelerLastName && String(md2.travelerLastName).trim()) ||
        null;

      const travelerEmail =
        (md2.travelerEmail && String(md2.travelerEmail).trim()) ||
        (session.customer_details?.email || "");

      const travelerPhone =
        (md2.travelerPhone && String(md2.travelerPhone).trim()) ||
        (session.customer_details?.phone || null);

      if (!travelerEmail) {
        console.error("[WH] missing traveler email, session:", session.id);
        await client.end();
        return res.status(400).send("Missing traveler email");
      }
      if (!travelerEmail) {
        console.error("[WH] missing traveler email, session:", session.id);
        await client.end();
        return res.status(400).send("Missing traveler email");
      }

      const currency = "USD";
      const amountPaid = (session.amount_total || 0) / 100;

      const ins = await client.query(
        `
        INSERT INTO extranet."Booking" (
          "bookingRef","partnerId","roomTypeId","ratePlanId",
          "checkInDate","checkOutDate","qty","guests",
          "travelerFirstName","travelerLastName","travelerEmail","travelerPhone",
          "currency","amountPaid",
          "paymentProvider","providerPaymentId","providerCustomerId",
          "status","createdAt","updatedAt",
          "pendingConfirmExpiresAt","refundDeadlineAt",
          "refundStatus","refundAttemptCount"
        )
        VALUES (
          $1,$2,$3,$4,
          $5,$6,$7,$8,
          $9,$10,$11,$12,
          $13,$14,
          'STRIPE',$15,$16,
          'PENDING_HOTEL_CONFIRMATION',$17,$18,
          $19,$20,
          'NOT_STARTED',0
        )
        RETURNING id
        `,
        [
          bookingRef, partnerId, roomTypeId, ratePlanId,
          checkInDate, checkOutDate, (Number.isFinite(qty) && qty > 0 ? qty : 1), guests,
          firstName, lastName, travelerEmail, travelerPhone,
          currency, amountPaid,
          providerPaymentId, (typeof session.customer === "string" ? session.customer : null),
          now, now,
          pendingConfirmExpiresAt, refundDeadlineAt
        ]
      );

      const bookingId = ins.rows[0].id as number;

      // ANCHOR: INSERT_BOOKING_ITEMS
      try {
        const md2: any = session.metadata || {};
        const raw = md2.cartItems ? String(md2.cartItems) : "";

        console.log(
          "[WH] cartItems present:",
          !!md2.cartItems,
          "len:",
          raw ? raw.length : 0
        );

        if (!raw) {
          console.log("[WH] no cartItems metadata, skipping BookingItem insert");
        } else {
          let items: any[] = [];
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) items = parsed;
          } catch (e) {
            console.error("[WH] cartItems JSON parse failed:", e);
            items = [];
          }

          if (!items.length) {
            console.log("[WH] cartItems empty or invalid array, skipping BookingItem insert");
          } else {
            let inserted = 0;
            for (const it of items) {
              const roomTypeId = Number(it.roomTypeId || 0);
              const ratePlanId = Number(it.ratePlanId || 0);
              const qty = Number(it.qty || 1);
              const currency = "USD";
              const lineTotal = Number(it.lineTotal || 0);

              const checkInDate = String(it.checkInDate || "");
              const checkOutDate = String(it.checkOutDate || "");

              if (!roomTypeId || !ratePlanId || !checkInDate || !checkOutDate) {
                continue;
              }

              await client.query(
                `INSERT INTO extranet."BookingItem"
                  ("bookingId","roomTypeId","ratePlanId","checkInDate","checkOutDate","qty","currency","lineTotal","createdAt")
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [bookingId, roomTypeId, ratePlanId, checkInDate, checkOutDate, qty, currency, lineTotal, now]
              );

              inserted++;
            }

            console.log("[WH] BookingItem inserted:", inserted, "for bookingId:", bookingId);
          }
        }
      } catch (e) {
        console.error("[WH] booking items insert failed:", e);
      }
      // ANCHOR: INSERT_BOOKING_ITEMS END

      // ANCHOR: INSERT_BOOKING_ADDONS
      try {
        const md2: any = session.metadata || {};
        const raw = md2.addons ? String(md2.addons) : "";

        console.log("[WH] addons present:", !!md2.addons, "len:", raw ? raw.length : 0);

        if (raw) {
          let arr: any[] = [];
          try { arr = JSON.parse(raw); } catch { arr = []; }
          
          // Resolve addOnId by (partnerId, activity, uom) from DB
          const partnerIdNum = Number(md2.partnerId || 0) || 0;

          let byKey = new Map<string, number>();
          if (partnerIdNum) {
            const lookup = await client.query(
              `
              SELECT id, activity, COALESCE(uom,'') AS uom
              FROM extranet."AddOn"
              WHERE "partnerId" = $1
              `,
              [partnerIdNum]
            );

            for (const r of lookup.rows) {
              const k = `${String(r.activity).trim().toLowerCase()}|${String(r.uom || "").trim().toLowerCase()}`;
              byKey.set(k, Number(r.id));
            }
          } else {
            console.log("[WH] partnerId missing in metadata; cannot resolve addOnId");
          }

          let inserted = 0;
          for (const a of arr) {
          const activity = String(a.activity || "").trim();
          const uom = String(a.uom || "").trim();
          const key = `${activity.toLowerCase()}|${uom.toLowerCase()}`;

          const addOnId = Number(a.addOnId || 0) || (byKey.get(key) || 0);

            if (!addOnId) continue;

            await client.query(
              `
              INSERT INTO extranet."BookingAddOn" (
                "bookingId","addOnId",
                activity,uom,"unitPrice",qty,currency,"lineTotal",notes
              )
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
              `,
              [
                bookingId,
                addOnId,
                String(a.activity || "").trim() || "Add-on",
                String(a.uom || "") || null,
                Number(a.unitPrice || 0),
                Number(a.qty || 1),
                String(currency).toUpperCase(),
                Number(a.lineTotal || 0),
                String(a.comment || "") || null,
              ]
            );

            inserted++;
          }

          console.log("[WH] BookingAddOn inserted:", inserted, "for bookingId:", bookingId);
        }
      } catch (e) {
        console.error("[WH] booking add-ons insert failed:", e);
      }
      // ANCHOR: INSERT_BOOKING_ADDONS END

      const token = crypto.randomBytes(24).toString("hex");
      await client.query(
        `INSERT INTO extranet."BookingConfirmToken" ("bookingId","token","expiresAt","createdAt")
         VALUES ($1,$2,$3,$4)`,
        [bookingId, token, pendingConfirmExpiresAt, now]
      );

      // ANCHOR: SEND_HOTEL_CONFIRM_EMAIL_AFTER_TOKEN
      try {
        // Look up hotel email from Partner (company profile)
        const hotelEmail = await getPartnerEmail(partnerId);
        const toEmail = hotelEmail || "bookings@lolaelo.com"; // safety fallback

        const base = process.env.PUBLIC_BASE_URL || "https://lolaelo-api.onrender.com";

        const confirmUrl = `${base}/api/bookings/confirm?token=${encodeURIComponent(token)}`;
        const declineUrl = `${base}/api/bookings/decline?token=${encodeURIComponent(token)}`;

        const qGuest = await client.query(
          `SELECT "travelerFirstName","travelerLastName" FROM extranet."Booking" WHERE id = $1 LIMIT 1`,
          [bookingId]
        );
        const travelerFirst = qGuest.rows?.[0]?.travelerFirstName || "";
        const travelerLast  = qGuest.rows?.[0]?.travelerLastName || "";

        const guestName =
          [travelerFirst, travelerLast].filter(Boolean).join(" ").trim() || "Traveler";
        const guestsCount = Number(guests || qty || 1) || 1;

        const subject = `Action needed: confirm booking ${bookingRef}`;

        const respondBy = (() => {
          const d = new Date(pendingConfirmExpiresAt as any);
          if (Number.isNaN(d.getTime())) {
            return String(pendingConfirmExpiresAt);
          }

          const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).formatToParts(d);

          const get = (type: string) => parts.find(p => p.type === type)?.value || "";
          return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
        })();

        console.log("[debug-emailA] respondBy raw:", {
          pendingConfirmExpiresAt,
          respondBy
        });

        const aqHotel = await client.query(
          `
          SELECT activity, qty
          FROM extranet."BookingAddOn"
          WHERE "bookingId" = $1
          ORDER BY id ASC
          `,
          [bookingId]
        );

        const addonsHotel = aqHotel.rows || [];
        const addonsHotelText = addonsHotel.length
          ? addonsHotel.map(r => `${r.activity}${Number(r.qty || 0) > 1 ? ` x${r.qty}` : ""}`).join(", ")
          : "";

        const html = hotelConfirmEmailHtml({
          bookingRef,
          guestName,
          checkIn: String(checkInDate).slice(0, 10),
          checkOut: String(checkOutDate).slice(0, 10),
          qty: Number(qty || 1),
          guests: guestsCount,
          addons: addonsHotelText,
          amountPaid: `${currency} ${Number(amountPaid).toFixed(2)}`,
          respondBy,
          confirmUrl,
          declineUrl,
        });

        // Hotel confirmation request
        await sendMailReal({
          from: "bookings@lolaelo.com",
          to: toEmail,
          bcc: "bookings@lolaelo.com",
          subject,
          html,
        });
        console.log("[booking-email] sent:", { to: toEmail, bookingRef });

        // Traveler soft confirmation (pending hotel confirmation)
        const qTraveler = await client.query(
          `
          SELECT
            b."travelerEmail",
            b."travelerFirstName",
            b."travelerLastName",
            b."checkInDate",
            b."checkOutDate",
            b.qty,
            b.guests,
            b.currency,
            b."amountPaid",
            b.status AS "bookingStatus",
            COALESCE(pp.name, p.name, ('Partner #' || b."partnerId"::text)) AS "propertyName"
          FROM extranet."Booking" b
          LEFT JOIN extranet."PropertyProfile" pp ON pp."partnerId" = b."partnerId"
          LEFT JOIN extranet."Partner" p ON p.id = b."partnerId"
          WHERE b.id = $1
          LIMIT 1
          `,
          [bookingId]
        );

        const travelerTo = String(qTraveler.rows?.[0]?.travelerEmail || "").trim();

        const bTravelerFirst = String(qTraveler.rows?.[0]?.travelerFirstName || "").trim();
        const bTravelerLast  = String(qTraveler.rows?.[0]?.travelerLastName || "").trim();

        const bPropertyName = String(qTraveler.rows?.[0]?.propertyName || "").trim() || "Hotel partner";
        const bCheckIn = String(qTraveler.rows?.[0]?.checkInDate || "").slice(0, 10);
        const bCheckOut = String(qTraveler.rows?.[0]?.checkOutDate || "").slice(0, 10);

        const bRoomsQty = Number(qTraveler.rows?.[0]?.qty || 1) || 1;
        const bGuestsCount = Number(qTraveler.rows?.[0]?.guests || 1) || 1;

        const bCur = String(qTraveler.rows?.[0]?.currency || "USD").toUpperCase();
        const bAmt = Number(qTraveler.rows?.[0]?.amountPaid || 0);

        const bBookingStatus = String(
          qTraveler.rows?.[0]?.bookingStatus || "PENDING_HOTEL_CONFIRMATION"
        );

        const aqB = await client.query(
          `
          SELECT activity, qty
          FROM extranet."BookingAddOn"
          WHERE "bookingId" = $1
          ORDER BY id ASC
          `,
          [bookingId]
        );

        const bAddons = aqB.rows || [];
        const bAddonsText = bAddons.length
          ? bAddons.map(r => `${r.activity}${Number(r.qty || 0) > 1 ? ` x${r.qty}` : ""}`).join(", ")
          : "";

        if (travelerTo) {
          const base = process.env.PUBLIC_BASE_URL || "https://lolaelo-api.onrender.com";
          const logoUrl = `${base}/images/logo.png`;

          const travelerHtml = `<!doctype html>
          <html>
            <body style="margin:0;background:#f6f7fb;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0b1320;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7fb;padding:24px 12px;">
                <tr>
                  <td align="center">
                    <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e8ebf3;border-radius:14px;overflow:hidden;">
                      <!-- Top bar -->
                      <tr>
                        <td style="padding:18px 20px;border-bottom:2px solid #ff6a3d;">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                            <tr>
                              <td align="left" style="vertical-align:middle;">
                                <a href="https://www.lolaelo.com" style="text-decoration:none;">
                                  <img src="${logoUrl}" alt="Lolaelo" height="120" style="display:block;border:0;outline:none;">
                                </a>
                              </td>
                              <td align="right" style="vertical-align:middle;font-size:13px;color:#334155;">
                                <a href="mailto:customer_support@lolaelo.com" style="color:#0f766e;text-decoration:none;font-weight:600;">
                                  customer_support@lolaelo.com
                                </a>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>

                      <!-- Title -->
                      <tr>
                        <td style="padding:20px 20px 8px 20px;">
                          <div style="font-size:24px;font-weight:800;line-height:1.25;">
                            Booking received: <span style="color:#ff6a3d;">${bookingRef}</span>
                            <span style="font-weight:600;color:#475569;font-size:18px;">(pending hotel confirmation)</span>
                          </div>
                          <div style="margin-top:10px;font-size:14px;color:#475569;">
                            Dear ${travelerFirst || "Traveler"},
                          </div>
                        </td>
                      </tr>

                      <!-- Intro -->
                      <tr>
                        <td style="padding:0 20px 14px 20px;font-size:14px;color:#334155;line-height:20px;">
                          Thank you for booking with <b>Lolaelo</b>. We’ve successfully received your booking request and payment.
                          <br><br>
                          Your reservation has been sent to the hotel and is currently awaiting confirmation.
                        </td>
                      </tr>

                      <!-- I. Booking details card -->
                      <tr>
                        <td style="padding:0 20px 18px 20px;">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8ebf3;border-radius:12px;">
                            <tr>
                              <td style="padding:14px 14px 10px 14px;background:#f9fbff;border-bottom:1px solid #e8ebf3;">
                                <div style="font-size:16px;font-weight:800;color:#0f766e;">Reservation details</div>
                              </td>
                            </tr>
                              <tr>
                                <td style="padding:14px;font-size:14px;color:#0b1320;line-height:22px;">
                                  <div>• <b>Property:</b> ${bPropertyName}</div>
                                  <div>• <b>Check-in date:</b> ${bCheckIn}</div>
                                  <div>• <b>Check-out date:</b> ${bCheckOut}</div>
                                  <div>• <b>Rooms:</b> ${bRoomsQty}</div>
                                  <div>• <b>Guests:</b> ${bGuestsCount}</div>
                                  ${bAddonsText ? `<div>• <b>Add-ons:</b> ${bAddonsText}</div>` : ``}
                                  <div>• <b>Booking status:</b> ${String(bBookingStatus || "").replaceAll("_"," ").trim()}</div>
                                  <div>• <b>Booking reference:</b> ${bookingRef}</div>
                                </td>
                              </tr>
                          </table>
                        </td>
                      </tr>

                      <!-- II. Payment status -->
                      <tr>
                        <td style="padding:0 20px 10px 20px;">
                          <div style="font-size:16px;font-weight:800;color:#0f766e;">II. Payment status</div>
                          <div style="margin-top:8px;font-size:14px;color:#334155;line-height:22px;">
                            We’ve received your payment in full.
                            <div style="margin-top:8px;">
                              • <b>Amount paid:</b> ${bCur} ${bAmt.toFixed(2)}<br>
                              • <b>Payment status:</b> Received<br>
                            </div>
                          </div>
                        </td>
                      </tr>

                      <!-- III. Next -->
                      <tr>
                        <td style="padding:10px 20px 8px 20px;">
                          <div style="font-size:16px;font-weight:800;color:#0f766e;">III. What happens next</div>
                          <div style="margin-top:8px;font-size:14px;color:#334155;line-height:22px;">
                            The hotel partner is reviewing your booking request.
                            <br><br>
                            Once the hotel confirms, you’ll receive a follow-up email with your confirmed reservation details.
                          </div>
                        </td>
                      </tr>

                      <!-- Reassurance box -->
                      <tr>
                        <td style="padding:0 20px 18px 20px;">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8ebf3;border-radius:12px;background:#f9fbff;">
                            <tr>
                              <td style="padding:14px 14px 12px 14px;">
                                <div style="font-size:14px;font-weight:800;color:#0f766e;margin-bottom:6px;">What happens next</div>

                                <div style="font-size:13px;color:#0b1320;line-height:20px;margin-bottom:8px;">
                                  The hotel has up to <b>24 hours</b> to confirm or decline your booking.
                                </div>

                                <div style="font-size:13px;color:#0b1320;line-height:20px;margin-bottom:8px;">
                                  <b>No action needed from your end.</b> We’ll email you as soon as the hotel responds.
                                </div>

                                <div style="font-size:13px;color:#0b1320;line-height:20px;">
                                  If the hotel declines or the 24-hour window expires, you’ll receive a <b>full refund</b> back to the <b>original form of payment</b> within <b>48 hours</b>.
                                </div>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>

                      <!-- Footer -->
                      <tr>
                        <td style="padding:14px 20px;border-top:1px solid #e8ebf3;font-size:12px;color:#64748b;text-align:center;">
                          Questions? Reply to this email or contact
                          <a href="mailto:customer_support@lolaelo.com" style="color:#0f766e;text-decoration:none;font-weight:600;">customer_support@lolaelo.com</a>.
                        </td>
                      </tr>
                    </table>

                    <div style="font-size:12px;color:#94a3b8;margin-top:12px;">© ${new Date().getFullYear()} Lolaelo</div>
                  </td>
                </tr>
              </table>
            </body>
          </html>`;
          const travelerSubject = `Booking received: ${bookingRef} (pending hotel confirmation)`;
          await sendMailReal({
            from: "bookings@lolaelo.com",
            to: travelerTo,
            subject: travelerSubject,
            html: travelerHtml,
          });
          console.log("[traveler-email] soft confirmation sent:", { to: travelerTo, bookingRef });
        } else {
          console.warn("[traveler-email] missing travelerEmail; soft confirmation not sent", {
            bookingId,
            bookingRef,
          });
        }
        } catch (e) {
          const errMsg = (e instanceof Error ? e.message : String(e)) || "unknown_error";
          const errShort = errMsg.slice(0, 500);

          console.error("[booking-email] failed:", e);

          try {
            await client.query(
              `INSERT INTO extranet."BookingEvent"
                ("bookingId","fromStatus","toStatus","actorType","actorId","note","createdAt")
              VALUES
                ($1, NULL, 'PENDING_HOTEL_CONFIRMATION', 'SYSTEM', NULL, $2, $3)`,
              [bookingId, `HOTEL_EMAIL_FAILED: ${errShort}`, now]
            );
          } catch (e2) {
            console.error("[booking-email] failed to log event:", e2);
          }
        }
      // ANCHOR: SEND_HOTEL_CONFIRM_EMAIL_AFTER_TOKEN END

      await client.query(
        `INSERT INTO extranet."BookingEvent" ("bookingId","fromStatus","toStatus","actorType","actorId","note","createdAt")
         VALUES ($1, NULL, 'PENDING_HOTEL_CONFIRMATION', 'SYSTEM', NULL, $2, $3)`,
        [bookingId, "Payment confirmed via Stripe Checkout", now]
      );

      await client.end();
      return res.json({ received: true });
    } catch (e) {
      try { await client.end(); } catch {}
      throw e;
    }
  } catch (err) {
    console.error("[WH] booking create failed:", err);
    return res.status(500).send("Webhook processing failed");
  }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ---- Static ----
const pubPath = path.join(__dirname, "..", "public");
app.use("/public", express.static(pubPath, { maxAge: "1h", etag: true }));
app.use(express.static(pubPath, { extensions: ["html"], maxAge: "1h", etag: true }));

// ANCHOR: BOOKING_CONFIRM_LINK_ENDPOINTS
function redirectToManageBookings(res: Response, result: string, bookingRef?: string) {
  const qs = new URLSearchParams();
  qs.set("result", result);
  if (bookingRef) qs.set("bookingRef", bookingRef);
  return res.redirect(302, `/partners_manage_bookings.html?${qs.toString()}`);
}

async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const cs = process.env.DATABASE_URL || "";
  if (!cs) throw new Error("DATABASE_URL missing");

  const client = new Client({
    connectionString: cs,
    ssl: wantsSSL(cs) ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();
  try {
    return await fn(client);
  } finally {
    try { await client.end(); } catch {}
  }
}

// ANCHOR: GET_PARTNER_EMAIL
async function getPartnerEmail(partnerId: number): Promise<string> {
  return withDb(async (client) => {
    const q = await client.query(
      `SELECT email FROM extranet."Partner" WHERE id = $1 LIMIT 1`,
      [partnerId]
    );
    const email = q.rows?.[0]?.email ? String(q.rows[0].email).trim() : "";
    return email;
  });
}
// ANCHOR: GET_PARTNER_EMAIL END

// ANCHOR: HOTEL_CONFIRM_EMAIL_TEMPLATE
function hotelConfirmEmailHtml(args: {
  bookingRef: string;
  guestName: string;
  checkIn: string;
  checkOut: string;
  qty: number;
  guests?: number;
  addons?: string;
  amountPaid: string;
  respondBy: string;
  confirmUrl: string;
  declineUrl: string;
}) {
  return `
  <div style="font-family:Inter,system-ui,Segoe UI,Roboto,Arial; line-height:1.45; color:#0f172a;">
    <h2 style="margin:0 0 10px;">
      Booking request: <span style="color:#ff6a3d;">${args.bookingRef}</span>
    </h2>

    <p style="margin:0 0 12px;">
      Please confirm or decline this booking request. If no action is taken within 24 hours, this booking will expire automatically.
    </p>

    <div style="padding:12px 14px; border:1px solid rgba(15,23,42,.12); border-radius:12px; background:#fff;">
      <div><b>Guest:</b> ${args.guestName}</div>
      <div><b>Stay:</b> ${args.checkIn} to ${args.checkOut}</div>
      <div><b>Rooms:</b> ${args.qty}</div>
      <div><b>Guests:</b> ${Number(args.guests || 1)}</div>
      ${args.addons ? `<div><b>Add-ons:</b> ${args.addons}</div>` : ``}
      <div><b>Amount paid:</b> ${args.amountPaid}</div>
      <div><b>Respond by:</b> ${args.respondBy} ET</div>
    </div>

    <div style="margin-top:14px; display:flex; gap:10px; flex-wrap:wrap;">
      <a href="${args.confirmUrl}" style="background:#16a34a; color:#fff; text-decoration:none; padding:10px 14px; border-radius:999px; font-weight:700;">
        Confirm booking
      </a>
      <a href="${args.declineUrl}" style="background:#dc2626; color:#fff; text-decoration:none; padding:10px 14px; border-radius:999px; font-weight:700;">
        Decline booking
      </a>
    </div>

    <p style="margin-top:14px; color:#475569; font-size:13px;">
      These links are single-use and expire automatically.
    </p>
  </div>`;
}
// ANCHOR: HOTEL_CONFIRM_EMAIL_TEMPLATE END

// ANCHOR: MAIL_SENDER
    // Uses Postmark for transactional email (bookings, receipts, etc.)
    // OTP continues to use src/mailer.ts (sendLoginCodeEmail) with POSTMARK_TOKEN.
    const DISABLE_EMAILS = process.env.DISABLE_EMAILS === "1";

    async function sendMailReal(args: {
      to: string;
      subject: string;
      html: string;
      from?: string;
      bcc?: string;
    }) {
      // Prefer explicit "from" if provided, otherwise Render env FROM_EMAIL (via mailer.ts)
      // Postmark supports BCC, but we keep it simple: send a second copy if bcc is provided.
      const to = args.to;
      const subject = args.subject;
      const html = args.html;

      if (DISABLE_EMAILS) {
        console.log("[email] DISABLE_EMAILS=1 skipping send", {
          to,
          subject,
          from: args.from || ""
        });
        return { ok: true, skipped: true };
      }

      const text = html
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<\/(p|div|br|tr|h1|h2|h3)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      // Primary send
      await sendBookingEmail({
        to,
        subject,
        html,
        text,
        tag: "booking",
      });

      // Optional BCC as a second send (avoids changing mailer.ts signature)
      if (args.bcc) {
        await sendBookingEmail({
          to: args.bcc,
          subject,
          html,
          text,
          tag: "booking-bcc",
        });
      }

      return { ok: true };
    }

// ANCHOR: MAIL_SENDER END

async function handleBookingDecision(req: Request, res: Response, decision: "CONFIRM" | "DECLINE") {
  const token = String(req.query.token || "").trim();
  if (!token) return redirectToManageBookings(res, "invalid");

  const now = new Date();

  return withDb(async (client) => {
    // 1) Load token + bookingRef for validation messaging
    const pre = await client.query(
      `
      SELECT
        t.id,
        t."bookingId",
        t."expiresAt",
        t."usedAt",
        b."bookingRef",
        b.status AS "bookingStatus"
      FROM extranet."BookingConfirmToken" t
      JOIN extranet."Booking" b ON b.id = t."bookingId"
      WHERE t.token = $1
      LIMIT 1
      `,
      [token]
    );

    if (!pre.rows.length) return redirectToManageBookings(res, "invalid");

    const row = pre.rows[0];
    const bookingId = Number(row.bookingId);
    const bookingRef = String(row.bookingRef || "");
    const expiresAt = row.expiresAt ? new Date(row.expiresAt) : null;
    const usedAt = row.usedAt ? new Date(row.usedAt) : null;

    if (usedAt) return redirectToManageBookings(res, "used", bookingRef);
    if (expiresAt && expiresAt.getTime() <= now.getTime()) return redirectToManageBookings(res, "expired", bookingRef);

    // 2) Transaction: mark token used (idempotency lock) -> update booking -> insert event
    await client.query("BEGIN");
    try {
      // Mark token used ONLY if still unused and not expired (this is your idempotency lock)
      const lock = await client.query(
        `
        UPDATE extranet."BookingConfirmToken"
        SET "usedAt" = $2
        WHERE token = $1
          AND "usedAt" IS NULL
          AND "expiresAt" > $2
        RETURNING "bookingId"
        `,
        [token, now]
      );

      if (lock.rowCount === 0) {
        await client.query("ROLLBACK");

        // Determine whether it became used or expired
        const chk = await client.query(
          `
          SELECT t."usedAt", t."expiresAt", b."bookingRef"
          FROM extranet."BookingConfirmToken" t
          JOIN extranet."Booking" b ON b.id = t."bookingId"
          WHERE t.token = $1
          LIMIT 1
          `,
          [token]
        );

        if (!chk.rows.length) return redirectToManageBookings(res, "invalid", bookingRef);

        const used = chk.rows[0].usedAt != null;
        const exp = chk.rows[0].expiresAt ? new Date(chk.rows[0].expiresAt) : null;

        if (used) return redirectToManageBookings(res, "used", bookingRef);
        if (exp && exp.getTime() <= now.getTime()) return redirectToManageBookings(res, "expired", bookingRef);

        return redirectToManageBookings(res, "invalid", bookingRef);
      }

      const lockedBookingId = Number(lock.rows[0].bookingId);

      // Get current status for event logging (lock row)
      const cur = await client.query(
        `SELECT status FROM extranet."Booking" WHERE id = $1 FOR UPDATE`,
        [lockedBookingId]
      );
      const fromStatus = cur.rows.length ? (cur.rows[0].status as string) : null;

      const toStatus = decision === "CONFIRM" ? "CONFIRMED" : "DECLINED_BY_HOTEL";

      // Update booking status + timestamps
      await client.query(
        `
        UPDATE extranet."Booking"
        SET
          status = $2::extranet."BookingStatus",
          "confirmedAt" = CASE WHEN $2::extranet."BookingStatus" = 'CONFIRMED'::extranet."BookingStatus" THEN $3 ELSE "confirmedAt" END,
          "declinedAt"  = CASE WHEN $2::extranet."BookingStatus" = 'DECLINED_BY_HOTEL'::extranet."BookingStatus" THEN $3 ELSE "declinedAt" END,
          "updatedAt"   = $3
        WHERE id = $1
        `,
        [lockedBookingId, toStatus, now]
      );

      // Insert BookingEvent (matches your existing schema usage)
      await client.query(
        `
        INSERT INTO extranet."BookingEvent"
          ("bookingId","fromStatus","toStatus","actorType","actorId","note","createdAt")
        VALUES
          ($1, $2, $3, 'HOTEL', NULL, $4, $5)
        `,
        [
          lockedBookingId,
          fromStatus,
          toStatus,
          decision === "CONFIRM" ? "Hotel confirmed via email link" : "Hotel declined via email link",
          now
        ]
      );

      await client.query("COMMIT");

      // Traveler post-decision email (confirm or decline)
      const q = await client.query(
        `
        SELECT
          b."travelerEmail",
          b."travelerFirstName",
          b."travelerLastName",
          b."checkInDate",
          b."checkOutDate",
          b.qty,
          b.guests,
          b.currency,
          b."amountPaid",
          b."partnerId",
          COALESCE(pp.name, p.name, ('Partner #' || b."partnerId"::text)) AS "propertyName"
        FROM extranet."Booking" b
        LEFT JOIN extranet."PropertyProfile" pp ON pp."partnerId" = b."partnerId"
        LEFT JOIN extranet."Partner" p ON p.id = b."partnerId"
        WHERE b.id = $1
        LIMIT 1
        `,
        [lockedBookingId]
      );

      const travelerTo = String(q.rows?.[0]?.travelerEmail || "").trim();
      const travelerFirst = String(q.rows?.[0]?.travelerFirstName || "").trim();
      const travelerLast  = String(q.rows?.[0]?.travelerLastName || "").trim();

      const propertyName = String(q.rows?.[0]?.propertyName || "").trim() || "Hotel partner";
      const checkIn = String(q.rows?.[0]?.checkInDate || "").slice(0, 10);
      const checkOut = String(q.rows?.[0]?.checkOutDate || "").slice(0, 10);

      const roomsQty = Number(q.rows?.[0]?.qty || 1) || 1;
      const guestsCount = Number(q.rows?.[0]?.guests || 1) || 1;

      const dCur = String(q.rows?.[0]?.currency || "USD").toUpperCase();
      const dAmt = Number(q.rows?.[0]?.amountPaid || 0);

      const partnerId = Number(q.rows?.[0]?.partnerId || 0) || 0;
      const hotelEmail = partnerId ? (await getPartnerEmail(partnerId)) : "";

      try {
        if (travelerTo) {
            const isConfirm = decision === "CONFIRM";

            const travelerSubject = isConfirm
              ? `Booking confirmed: ${bookingRef}`
              : `Booking declined: ${bookingRef}`;

            const base = process.env.PUBLIC_BASE_URL || "https://lolaelo-api.onrender.com";
            const logoUrl = `${base}/images/logo.png`;

            const aqC = await client.query(
              `
              SELECT activity, qty
              FROM extranet."BookingAddOn"
              WHERE "bookingId" = $1
              ORDER BY id ASC
              `,
              [lockedBookingId]
            );

            const cAddons = aqC.rows || [];
            const cAddonsText = cAddons.length
              ? cAddons.map(r => `${r.activity}${Number(r.qty || 0) > 1 ? ` x${r.qty}` : ""}`).join(", ")
              : "";

            const travelerHtml = isConfirm
              ? `<!doctype html>
            <html>
              <body style="margin:0;background:#f6f7fb;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0b1320;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7fb;padding:24px 12px;">
                  <tr>
                    <td align="center">
                      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e8ebf3;border-radius:14px;overflow:hidden;">
                        <tr>
                          <td style="padding:18px 20px;border-bottom:2px solid #ff6a3d;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                              <tr>
                                <td align="left" style="vertical-align:middle;">
                                  <a href="https://www.lolaelo.com" style="text-decoration:none;">
                                    <img src="${logoUrl}" alt="Lolaelo" height="120" style="display:block;border:0;outline:none;">
                                  </a>
                                </td>
                                <td align="right" style="vertical-align:middle;font-size:13px;color:#334155;">
                                  <a href="mailto:customer_support@lolaelo.com" style="color:#0f766e;text-decoration:none;font-weight:600;">
                                    customer_support@lolaelo.com
                                  </a>
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>

                        <tr>
                          <td style="padding:20px 20px 8px 20px;">
                            <div style="font-size:24px;font-weight:800;line-height:1.25;">
                              Booking confirmed: <span style="color:#ff6a3d;">${bookingRef}</span>
                            </div>
                            <div style="margin-top:10px;font-size:14px;color:#334155;">
                              Status: <span style="display:inline-block;border:1px solid #99f6e4;color:#0f766e;padding:2px 10px;border-radius:999px;font-weight:700;font-size:12px;">Confirmed by the hotel</span>
                            </div>
                          </td>
                        </tr>

                        <!-- C2: opening message -->
                        <tr>
                          <td style="padding:0 20px 16px 20px;">
                            <div style="font-size:14px;color:#0b1320;line-height:22px;">
                              Thank you for booking with Lolaelo. We work with independent hotel partners to keep travel safe, straightforward, and affordable.
                            </div>

                            <div style="font-size:14px;color:#0b1320;line-height:22px;margin-top:10px;">
                              <b>Expect to hear directly from the hotel partner via email shortly after this confirmation.</b>
                            </div>

                            ${hotelEmail ? `
                            <div style="font-size:13px;color:#475569;line-height:20px;margin-top:8px;">
                              Or reach out directly at
                              <a href="mailto:${hotelEmail}" style="color:#0f766e;text-decoration:none;">${hotelEmail}</a>.
                            </div>
                            ` : ``}
                          </td>
                        </tr>

                        <tr>
                          <td style="padding:0 20px 16px 20px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8ebf3;border-radius:12px;">
                              <tr>
                                <td style="padding:14px 14px 10px 14px;background:#f9fbff;border-bottom:1px solid #e8ebf3;">
                                  <div style="font-size:16px;font-weight:800;color:#0f766e;">Reservation details</div>
                                </td>
                              </tr>
                              <tr>
                                <td style="padding:14px;font-size:14px;color:#0b1320;line-height:22px;">
                                  <div>• <b>Property:</b> ${propertyName}</div>
                                  <div>• <b>Check-in date:</b> ${checkIn}</div>
                                  <div>• <b>Check-out date:</b> ${checkOut}</div>
                                  <div>• <b>Rooms:</b> ${roomsQty}</div>
                                  <div>• <b>Guests:</b> ${guestsCount}</div>
                                  ${cAddonsText ? `<div>• <b>Add-ons:</b> ${cAddonsText}</div>` : ``}
                                  <div>• <b>Booking reference:</b> ${bookingRef}</div>
                                  <div>• <b>Status:</b> Confirmed</div>
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>

                        <tr>
                          <td style="padding:0 20px 18px 20px;font-size:14px;color:#334155;line-height:20px;">
                            If you have any questions or concerns about this booking, please reply to this email or contact
                            <a href="mailto:customer_support@lolaelo.com" style="color:#0f766e;text-decoration:none;font-weight:700;">customer_support@lolaelo.com</a>.
                          </td>
                        </tr>

                        <tr>
                          <td style="padding:14px 20px;border-top:1px solid #e8ebf3;font-size:12px;color:#64748b;text-align:center;">
                            Thank you for booking with Lolaelo.
                          </td>
                        </tr>
                      </table>

                      <div style="font-size:12px;color:#94a3b8;margin-top:12px;">© ${new Date().getFullYear()} Lolaelo</div>
                    </td>
                  </tr>
                </table>
              </body>
            </html>`
              : `<!doctype html>
            <html>
              <body style="margin:0;background:#f6f7fb;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0b1320;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7fb;padding:24px 12px;">
                  <tr>
                    <td align="center">
                      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e8ebf3;border-radius:14px;overflow:hidden;">
                        <tr>
                          <td style="padding:18px 20px;border-bottom:2px solid #ff6a3d;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                              <tr>
                                <td align="left" style="vertical-align:middle;">
                                  <a href="https://www.lolaelo.com" style="text-decoration:none;">
                                    <img src="${logoUrl}" alt="Lolaelo" height="120" style="display:block;border:0;outline:none;">
                                  </a>
                                </td>
                                <td align="right" style="vertical-align:middle;font-size:13px;color:#334155;">
                                  <a href="mailto:customer_support@lolaelo.com" style="color:#0f766e;text-decoration:none;font-weight:600;">
                                    customer_support@lolaelo.com
                                  </a>
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>

                        <tr>
                          <td style="padding:20px 20px 8px 20px;">
                            <div style="font-size:24px;font-weight:800;line-height:1.25;">
                              Booking declined: <span style="color:#ff6a3d;">${bookingRef}</span>
                            </div>
                            <div style="margin-top:10px;font-size:14px;color:#334155;">
                              Status: <span style="display:inline-block;border:1px solid #fecaca;color:#b91c1c;padding:2px 10px;border-radius:999px;font-weight:700;font-size:12px;">Declined by the hotel</span>
                            </div>
                          </td>
                        </tr>

                        <!-- Decline message -->
                        <tr>
                          <td style="padding:0 20px 16px 20px;">
                            <div style="font-size:14px;color:#0b1320;line-height:22px;">
                              Unfortunately, the hotel declined this booking.
                            </div>

                            <div style="font-size:14px;color:#0b1320;line-height:22px;margin-top:10px;">
                              You will receive a <b>full refund</b> back to the <b>original form of payment</b> within <b>48 hours</b> from this message. <b>No action needed from your end.</b>
                            </div>

                            <div style="font-size:13px;color:#475569;line-height:20px;margin-top:10px;">
                              Note from Manny: I am sorry this happened. We review every declined booking and work closely with our partners to minimize situations like this from happening. If you would like, feel free to browse our catalog again and see if another property works better for your plans. 
                            </div>

                          </td>
                        </tr>

                        <!-- D: reservation details card (optional) -->
                        <tr>
                          <td style="padding:0 20px 18px 20px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8ebf3;border-radius:12px;">
                              <tr>
                                <td style="padding:14px 14px 10px 14px;background:#f9fbff;border-bottom:1px solid #e8ebf3;">
                                  <div style="font-size:16px;font-weight:800;color:#0f766e;">Reservation details</div>
                                </td>
                                  <tr>
                                    <td style="padding:14px;font-size:14px;color:#0b1320;line-height:22px;">
                                      <div>• <b>Property:</b> ${propertyName}</div>
                                      <div>• <b>Check-in date:</b> ${checkIn}</div>
                                      <div>• <b>Check-out date:</b> ${checkOut}</div>
                                      <div>• <b>Rooms:</b> ${roomsQty}</div>
                                      <div>• <b>Guests:</b> ${guestsCount}</div>
                                      <div>• <b>Booking reference:</b> ${bookingRef}</div>
                                      <div>• <b>Status:</b> Declined</div>
                                    </td>
                                  </tr>
                            </table>
                          </td>
                        </tr>

                        <tr>
                          <td style="padding:0 20px 18px 20px;font-size:14px;color:#334155;line-height:20px;">
                            If you have any questions or concerns about this booking, please reply to this email or contact
                            <a href="mailto:customer_support@lolaelo.com" style="color:#0f766e;text-decoration:none;font-weight:700;">customer_support@lolaelo.com</a>.
                          </td>
                        </tr>

                        <tr>
                          <td style="padding:14px 20px;border-top:1px solid #e8ebf3;font-size:12px;color:#64748b;text-align:center;">
                            Thank you for booking with Lolaelo.
                          </td>
                        </tr>
                      </table>

                      <div style="font-size:12px;color:#94a3b8;margin-top:12px;">© ${new Date().getFullYear()} Lolaelo</div>
                    </td>
                  </tr>
                </table>
              </body>
            </html>`;

            await sendMailReal({
              from: "bookings@lolaelo.com",
              to: travelerTo,
              subject: travelerSubject,
              html: travelerHtml,
            });

            console.log("[traveler-email] decision sent:", {
              decision,
              to: travelerTo,
              bookingRef,
            });
          } else {
            console.warn("[traveler-email] missing travelerEmail; decision email not sent", {
              decision,
              bookingRef,
              bookingId: lockedBookingId,
            });
          }
      } catch (e) {
        console.error("[traveler-email] decision send failed:", e);
      }

      return redirectToManageBookings(
        res,
        decision === "CONFIRM" ? "confirmed" : "declined",
        bookingRef
      );
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch {}
      console.error("[confirm-link] tx failed:", e);
      return redirectToManageBookings(res, "invalid", String(row.bookingRef || ""));
    }
  });
}

// GET /api/bookings/confirm?token=...
app.get("/api/bookings/confirm", async (req: Request, res: Response) => {
  return handleBookingDecision(req, res, "CONFIRM");
});

// GET /api/bookings/decline?token=...
app.get("/api/bookings/decline", async (req: Request, res: Response) => {
  return handleBookingDecision(req, res, "DECLINE");
});
// ANCHOR: BOOKING_CONFIRM_LINK_ENDPOINTS END

// ANCHOR: RESEND_HOTEL_CONFIRMATION_ROUTE
app.post("/api/bookings/:bookingRef/resend-hotel-confirmation", async (req: Request, res: Response) => {
  const bookingRef = String(req.params.bookingRef || "").trim();
  if (!bookingRef) return res.status(400).json({ ok: false, error: "bookingRef_required" });

  try {
    const result = await withDb(async (client) => {
      const now = new Date();

      // 1) Load booking
      const bq = await client.query(
        `
        SELECT
          id,
          "partnerId",
          status,
          "checkInDate",
          "checkOutDate",
          qty,
          currency,
          "amountPaid",
          "pendingConfirmExpiresAt",
          "travelerFirstName",
          "travelerLastName"
        FROM extranet."Booking"
        WHERE "bookingRef" = $1
        LIMIT 1
        `,
        [bookingRef]
      );

      if (!bq.rows.length) return { ok: false, code: "not_found" };

      const b = bq.rows[0];
      const bookingId = Number(b.id);
      const partnerId = Number(b.partnerId);

      // Only resend for pending hotel confirmation
      if (String(b.status) !== "PENDING_HOTEL_CONFIRMATION") {
        return { ok: false, code: "not_pending", status: String(b.status) };
      }

      // 2) Get latest token
      const tq = await client.query(
        `
        SELECT id, token, "expiresAt", "usedAt"
        FROM extranet."BookingConfirmToken"
        WHERE "bookingId" = $1
        ORDER BY id DESC
        LIMIT 1
        `,
        [bookingId]
      );

      let token = tq.rows?.[0]?.token ? String(tq.rows[0].token) : "";
      const expiresAt = tq.rows?.[0]?.expiresAt ? new Date(tq.rows[0].expiresAt) : null;
      const usedAt = tq.rows?.[0]?.usedAt ? new Date(tq.rows[0].usedAt) : null;

      const isValidExisting =
        token && !usedAt && expiresAt && expiresAt.getTime() > now.getTime();

      // 3) Create new token if needed
      if (!isValidExisting) {
        token = crypto.randomBytes(24).toString("hex");

        // expiry = pendingConfirmExpiresAt if still in the future, else now+24h
        const pce = b.pendingConfirmExpiresAt ? new Date(b.pendingConfirmExpiresAt) : null;
        const newExpires = (pce && pce.getTime() > now.getTime())
          ? pce
          : new Date(now.getTime() + 24 * 60 * 60 * 1000);

        await client.query(
          `INSERT INTO extranet."BookingConfirmToken" ("bookingId","token","expiresAt","createdAt")
           VALUES ($1,$2,$3,$4)`,
          [bookingId, token, newExpires, now]
        );
      }

      // 4) Send email
      const hotelEmail = await getPartnerEmail(partnerId);
      const toEmail = hotelEmail || "bookings@lolaelo.com";

      const base = process.env.PUBLIC_BASE_URL || "https://lolaelo-api.onrender.com";
      const confirmUrl = `${base}/api/bookings/confirm?token=${encodeURIComponent(token)}`;
      const declineUrl = `${base}/api/bookings/decline?token=${encodeURIComponent(token)}`;

      const guestName =
        [b.travelerFirstName, b.travelerLastName].filter(Boolean).join(" ").trim() || "Traveler";

      const subject = `Action needed: confirm booking ${bookingRef}`;

      const html = hotelConfirmEmailHtml({
        bookingRef,
        guestName,
        checkIn: String(b.checkInDate).slice(0, 10),
        checkOut: String(b.checkOutDate).slice(0, 10),
        qty: Number(b.qty || 1),
        amountPaid: `${b.currency} ${Number(b.amountPaid).toFixed(2)}`,
        respondBy: String(b.pendingConfirmExpiresAt).replace("T", " ").slice(0, 19),
        confirmUrl,
        declineUrl,
      });

      try {
        await sendMailReal({ from: "bookings@lolaelo.com", to: toEmail, subject, html });

        await client.query(
          `INSERT INTO extranet."BookingEvent"
            ("bookingId","fromStatus","toStatus","actorType","actorId","note","createdAt")
           VALUES
            ($1, NULL, 'PENDING_HOTEL_CONFIRMATION', 'SYSTEM', NULL, $2, $3)`,
          [bookingId, `HOTEL_EMAIL_SENT: resend to ${toEmail}`, now]
        );

        return { ok: true, toEmail };
      } catch (e) {
        const errMsg = (e instanceof Error ? e.message : String(e)) || "unknown_error";
        const errShort = errMsg.slice(0, 500);

        await client.query(
          `INSERT INTO extranet."BookingEvent"
            ("bookingId","fromStatus","toStatus","actorType","actorId","note","createdAt")
           VALUES
            ($1, NULL, 'PENDING_HOTEL_CONFIRMATION', 'SYSTEM', NULL, $2, $3)`,
          [bookingId, `HOTEL_EMAIL_FAILED: resend ${errShort}`, now]
        );

        return { ok: false, code: "send_failed", error: errShort };
      }
    });

    if (!result.ok) {
      if (result.code === "not_found") return res.status(404).json(result);
      if (result.code === "not_pending") return res.status(409).json(result);
      return res.status(500).json(result);
    }

    return res.json(result);
  } catch (e) {
    console.error("[resend-hotel-confirmation] failed:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});
// ANCHOR: RESEND_HOTEL_CONFIRMATION_ROUTE END

// ANCHOR: PARTNER_BOOKINGS_LIST_ROUTE
app.get("/api/partners/bookings", async (req: Request, res: Response) => {
  const partnerId = Number(req.query.partnerId || 0);
  const bucket = String(req.query.bucket || "pending"); // pending | completed | canceled

  if (!partnerId) return res.status(400).json({ ok: false, error: "partnerId required" });

  try {
    const rows = await withDb(async (client) => {
      // Bucket filters (keep strict and explicit)
      let whereSql = `b."partnerId" = $1`;
      if (bucket === "pending") {
        whereSql += ` AND b.status IN ('PENDING_HOTEL_CONFIRMATION'::extranet."BookingStatus", 'CONFIRMED'::extranet."BookingStatus")`;
      } else if (bucket === "completed") {
        // placeholder until you define true completed semantics
        whereSql += ` AND b.status IN ('COMPLETED'::extranet."BookingStatus")`;
      } else if (bucket === "canceled") {
        whereSql += ` AND b.status IN (
          'DECLINED_BY_HOTEL'::extranet."BookingStatus",
          'EXPIRED'::extranet."BookingStatus",
          'CANCELED'::extranet."BookingStatus"
        )`;
      }

      const q = await client.query(
        `
        SELECT
          b.id,
          b."bookingRef",
          b.status,
          b."checkInDate",
          b."checkOutDate",
          b."qty",
          b."travelerFirstName",
          b."travelerLastName",
          rt.name AS "roomCategory",
          rp.name AS "ratePlan"
        FROM extranet."Booking" b
        LEFT JOIN extranet."RoomType" rt ON rt.id = b."roomTypeId"
        LEFT JOIN extranet."RatePlan" rp ON rp.id = b."ratePlanId"
        WHERE ${whereSql}
        ORDER BY
          CASE
            WHEN b.status = 'PENDING_HOTEL_CONFIRMATION'::extranet."BookingStatus" THEN 0
            ELSE 1
          END,
          b."checkInDate" ASC,
          b."createdAt" DESC
        LIMIT 200
        `,
        [partnerId]
      );

      return q.rows;
    });

    return res.json({ ok: true, rows });
  } catch (e) {
    console.error("[partner-bookings] failed:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});
// ANCHOR: PARTNER_BOOKINGS_LIST_ROUTE END

// ANCHOR: EXTRANET_ME_BOOKINGS_ROUTE
app.get("/api/extranet/me/bookings", async (req: Request, res: Response) => {
  const bucket = String(req.query.bucket || "pending");

  try {
    const partnerId = requirePartnerIdFromRequest(req); // ← replace with your real helper name

    const rows = await withDb(async (client) => {
      let whereSql = `b."partnerId" = $1`;

      if (bucket === "pending") {
        whereSql += ` AND b.status IN (
          'PENDING_HOTEL_CONFIRMATION'::extranet."BookingStatus",
          'CONFIRMED'::extranet."BookingStatus",
          'COMPLETED'::extranet."BookingStatus"
        )`;
      } else if (bucket === "canceled") {
        whereSql += ` AND b.status IN (
          'DECLINED_BY_HOTEL'::extranet."BookingStatus",
          'EXPIRED_NO_RESPONSE'::extranet."BookingStatus",
          'CANCELED_BY_TRAVELER'::extranet."BookingStatus"
        )`;
      } else if (bucket === "completed") {
        whereSql += ` AND b.status IN ('COMPLETED'::extranet."BookingStatus")`;
      }

      const q = await client.query(
        `
        SELECT
          b.id,
          b."bookingRef",
          b.status,
          b."checkInDate",
          b."checkOutDate",
          b."qty",
          b."travelerFirstName",
          b."travelerLastName",
          rt.name AS "roomCategory",
          rp.name AS "ratePlan",
          t.token AS "confirmToken",
          t."expiresAt" AS "tokenExpiresAt",
          COALESCE(s."itemCount", 0) AS "itemCount",
          COALESCE(s."itemsTotal", 0) AS "itemsTotal",
          COALESCE(ba."addonsTotal", 0) AS "addonsTotal",
          (COALESCE(s."itemsTotal", 0) + COALESCE(ba."addonsTotal", 0)) AS "grandTotal",
          s."minCheckInDate" AS "minCheckInDate",
          s."maxCheckOutDate" AS "maxCheckOutDate",
          COALESCE(s."hasVaryingDates", FALSE) AS "hasVaryingDates"
        FROM extranet."Booking" b
        LEFT JOIN extranet."RoomType" rt ON rt.id = b."roomTypeId"
        LEFT JOIN extranet."RatePlan" rp ON rp.id = b."ratePlanId"
        LEFT JOIN LATERAL (
          SELECT token, "expiresAt"
          FROM extranet."BookingConfirmToken"
          WHERE "bookingId" = b.id
            AND "usedAt" IS NULL
            AND "expiresAt" > NOW()
          ORDER BY id DESC
          LIMIT 1
        ) t ON TRUE
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::int AS "itemCount",
            COALESCE(SUM("lineTotal"), 0) AS "itemsTotal",
            MIN("checkInDate") AS "minCheckInDate",
            MAX("checkOutDate") AS "maxCheckOutDate",
            (COUNT(DISTINCT ("checkInDate","checkOutDate")) > 1) AS "hasVaryingDates"
          FROM extranet."BookingItem"
          WHERE "bookingId" = b.id
        ) s ON TRUE
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(SUM("lineTotal"), 0) AS "addonsTotal"
          FROM extranet."BookingAddOn"
          WHERE "bookingId" = b.id
        ) ba ON TRUE
        WHERE ${whereSql}
        ORDER BY
          CASE
            WHEN b.status = 'PENDING_HOTEL_CONFIRMATION'::extranet."BookingStatus" THEN 0
            ELSE 1
          END,
          b."checkInDate" ASC,
          b."createdAt" DESC
        LIMIT 200
        `,
        [partnerId]
      );

      return q.rows;
    });

    return res.json({ ok: true, rows });
  } catch (e) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
});
// ANCHOR: EXTRANET_ME_BOOKINGS_ROUTE END

// ANCHOR: EXTRANET_ME_PAYOUT_READY_ROUTE
app.get("/api/extranet/me/payout-ready", async (req: Request, res: Response) => {
  try {
    const partnerId = requirePartnerIdFromRequest(req);

    const rows = await withDb(async (client) => {
      const q = `
        SELECT
          b.id,
          b."bookingRef",
          b.status::text as status,
          b."checkInDate",
          b."checkOutDate",
          b.qty,
          b.guests,
          b.currency,
          b."amountPaid",
          COALESCE(pp.name, p.name, ('Partner #' || b."partnerId"::text)) AS "propertyName"
        FROM extranet."Booking" b
        LEFT JOIN extranet."PropertyProfile" pp ON pp."partnerId" = b."partnerId"
        LEFT JOIN extranet."Partner" p ON p.id = b."partnerId"
        WHERE b."partnerId" = $1
          AND b.status = 'COMPLETED'::extranet."BookingStatus"
          AND NOT EXISTS (
            SELECT 1 FROM extranet."PayoutBooking" pb WHERE pb."bookingId" = b.id
          )
        ORDER BY b."checkOutDate" DESC, b."createdAt" DESC
        LIMIT 500
      `;
      const r = await client.query(q, [partnerId]);
      return r.rows || [];
    });

    return res.json({ ok: true, rows });
  } catch {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
});
// ANCHOR: EXTRANET_ME_PAYOUT_READY_ROUTE END

// ANCHOR: EXTRANET_ME_PAYOUTS_ROUTE
app.get("/api/extranet/me/payouts", async (req: Request, res: Response) => {
  try {
    const partnerId = requirePartnerIdFromRequest(req);

    const rows = await withDb(async (client) => {
      const q = `
        SELECT
          p.id,
          p."weekStart",
          p."weekEnd",
          p.currency,
          p."amountNet",
          p.method,
          p."confirmationNumber",
          p."paidAt",
          p.status::text as status,
          p."createdAt",
          (SELECT COUNT(*) FROM extranet."PayoutBooking" pb WHERE pb."payoutId" = p.id) AS "bookingCount"
        FROM extranet."Payout" p
        WHERE p."partnerId" = $1
        ORDER BY COALESCE(p."paidAt", p."createdAt") DESC, p.id DESC
        LIMIT 200
      `;
      const r = await client.query(q, [partnerId]);
      return r.rows || [];
    });

    return res.json({ ok: true, rows });
  } catch {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
});
// ANCHOR: EXTRANET_ME_PAYOUTS_ROUTE END

// ANCHOR: EXTRANET_ME_PAYOUT_DETAIL_ROUTE
app.get("/api/extranet/me/payouts/:payoutId/bookings", async (req: Request, res: Response) => {
  const payoutId = Number(req.params.payoutId || 0);
  if (!payoutId) return res.status(400).json({ ok: false, error: "payoutId_required" });

  try {
    const partnerId = requirePartnerIdFromRequest(req);

    const data = await withDb(async (client) => {
      // Ensure payout belongs to this partner
      const pq = await client.query(
        `SELECT id, "partnerId", "weekStart", "weekEnd", currency, "amountNet", method, "confirmationNumber", "paidAt", status::text as status
         FROM extranet."Payout"
         WHERE id = $1 AND "partnerId" = $2
         LIMIT 1`,
        [payoutId, partnerId]
      );
      if (!pq.rows.length) return null;

      const items = await client.query(
        `
        SELECT
          pb.id,
          pb."bookingId",
          COALESCE(pb."bookingRef", b."bookingRef") AS "bookingRef",
          COALESCE(pb."propertyName", COALESCE(pp.name, p.name, ('Partner #' || b."partnerId"::text))) AS "propertyName",
          b."checkInDate",
          b."checkOutDate",
          b.currency,
          b."amountPaid",
          pb."netAmount"
        FROM extranet."PayoutBooking" pb
        JOIN extranet."Booking" b ON b.id = pb."bookingId"
        LEFT JOIN extranet."PropertyProfile" pp ON pp."partnerId" = b."partnerId"
        LEFT JOIN extranet."Partner" p ON p.id = b."partnerId"
        WHERE pb."payoutId" = $1
        ORDER BY b."checkInDate" DESC, b."createdAt" DESC
        `,
        [payoutId]
      );

      return { payout: pq.rows[0], bookings: items.rows || [] };
    });

    if (!data) return res.status(404).json({ ok: false, error: "not_found" });
    return res.json({ ok: true, ...data });
  } catch {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
});
// ANCHOR: EXTRANET_ME_PAYOUT_DETAIL_ROUTE END

// ANCHOR: EXTRANET_ME_BOOKING_DETAIL_ROUTE
app.get("/api/extranet/me/bookings/:bookingRef", async (req: Request, res: Response) => {
  const bookingRef = String(req.params.bookingRef || "").trim();
  if (!bookingRef) return res.status(400).json({ ok: false, error: "bookingRef_required" });

  try {
    const partnerId = requirePartnerIdFromRequest(req);

    const data = await withDb(async (client) => {
      const bq = await client.query(
        `
        SELECT
          b.id,
          b."bookingRef",
          b.status,
          b."partnerId",
          b."checkInDate",
          b."checkOutDate",
          b.qty,
          b.guests,
          b.currency,
          b."amountPaid",
          b."paymentProvider",
          b."providerPaymentId",
          b."pendingConfirmExpiresAt",
          b."refundDeadlineAt",
          b."travelerFirstName",
          b."travelerLastName",
          b."travelerEmail",
          b."travelerPhone",
          COALESCE(pp.name, p.name, ('Partner #' || b."partnerId"::text)) AS "propertyName"
        FROM extranet."Booking" b
        LEFT JOIN extranet."PropertyProfile" pp ON pp."partnerId" = b."partnerId"
        LEFT JOIN extranet."Partner" p ON p.id = b."partnerId"
        WHERE b."bookingRef" = $1
          AND b."partnerId" = $2
        LIMIT 1
        `,
        [bookingRef, partnerId]
      );

      if (!bq.rows.length) return null;

      const booking = bq.rows[0];
      const bookingId = Number(booking.id);

      const iq = await client.query(
        `
        SELECT
          bi.id,
          bi."roomTypeId",
          rt.name AS "roomTypeName",
          bi."ratePlanId",
          rp.name AS "ratePlanName",
          bi."checkInDate",
          bi."checkOutDate",
          bi.qty,
          bi.currency,
          bi."lineTotal"
        FROM extranet."BookingItem" bi
        LEFT JOIN extranet."RoomType" rt ON rt.id = bi."roomTypeId"
        LEFT JOIN extranet."RatePlan" rp ON rp.id = bi."ratePlanId"
        WHERE bi."bookingId" = $1
        ORDER BY bi.id ASC
        `,
        [bookingId]
      );

      const items = iq.rows || [];
      const itemsTotal = items.reduce((s: number, r: any) => s + Number(r.lineTotal || 0), 0);
      const itemCount = items.length;

      const aq = await client.query(
        `
        SELECT
          ba.id,
          ba."addOnId",
          ba.activity,
          ba.uom,
          ba."unitPrice",
          ba.qty,
          ba.currency,
          ba."lineTotal",
          ba.notes
        FROM extranet."BookingAddOn" ba
        WHERE ba."bookingId" = $1
        ORDER BY ba.id ASC
        `,
        [bookingId]
      );

      const addons = aq.rows || [];
      const addonsTotal = addons.reduce((s: number, r: any) => s + Number(r.lineTotal || 0), 0);

      return { booking, items, itemsTotal, itemCount, addons, addonsTotal };
    });

    if (!data) return res.status(404).json({ ok: false, error: "not_found" });
    return res.json({ ok: true, ...data });
  } catch (e) {
    console.error("[me-booking-detail] failed:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});
// ANCHOR: EXTRANET_ME_BOOKING_DETAIL_ROUTE END

// ANCHOR: EXTRANET_ME_BOOKING_MARK_COMPLETED_ROUTE
app.post("/api/extranet/me/bookings/:bookingRef/mark-completed", async (req: Request, res: Response) => {
  const bookingRef = String(req.params.bookingRef || "").trim();
  if (!bookingRef) return res.status(400).json({ ok: false, error: "bookingRef_required" });

  try {
    const partnerId = requirePartnerIdFromRequest(req);

    const result = await withDb(async (client) => {
      // Only allow CONFIRMED -> COMPLETED, scoped to the same partnerId
      const q = `
        update extranet."Booking"
           set status = 'COMPLETED'::extranet."BookingStatus",
               "completedAt" = NOW()
         where "bookingRef" = $1
           and "partnerId" = $2
           and status = 'CONFIRMED'::extranet."BookingStatus"
        returning id, "bookingRef", status::text as status, "partnerId", "completedAt"
      `;
      const r = await client.query(q, [bookingRef, partnerId]);
      return r.rows?.[0] || null;
    });

    if (!result) {
      // Either not found, wrong partner, or not in CONFIRMED state
      return res.status(409).json({ ok: false, error: "not_confirmed_or_not_found" });
    }

    return res.json({ ok: true, booking: result });
  } catch (e: any) {
    console.error("[extranet] mark-completed error", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});
// ANCHOR: EXTRANET_ME_BOOKING_MARK_COMPLETED_ROUTE END

// ANCHOR: BOOKINGS_BY_SESSION_ROUTE (LIVE)
app.get("/api/bookings/by-session", async (req: Request, res: Response) => {
  let client: Client | null = null;

  try {
    res.set("Cache-Control", "no-store");

    const sessionId = String(req.query.session_id || "").trim();
    if (!sessionId) {
      return res.status(400).json({ error: "Missing session_id" });
    }

    const cs = process.env.DATABASE_URL as string;
    if (!cs) {
      return res.status(500).json({ error: "Missing DATABASE_URL" });
    }

    client = new Client({
      connectionString: cs,
      ssl: wantsSSL(cs) ? { rejectUnauthorized: false } : undefined,
    });

    await client.connect();

    const { rows } = await client.query(
      `
      SELECT
        b."bookingRef",
        b.status,
        b."pendingConfirmExpiresAt",
        b."refundDeadlineAt",
        b."createdAt",
        b."checkInDate",
        b."checkOutDate",
        b.qty,
        b.currency,
        b."amountPaid",
        b."partnerId",
        COALESCE(pp.name, p.name, ('Partner #' || b."partnerId"::text)) AS "propertyName"
      FROM extranet."Booking" b
      LEFT JOIN extranet."PropertyProfile" pp
        ON pp."partnerId" = b."partnerId"
      LEFT JOIN extranet."Partner" p
        ON p.id = b."partnerId"
      WHERE b."providerPaymentId" = $1
      ORDER BY b.id DESC
      LIMIT 1
      `,
      [sessionId]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "Booking not found" });
    }

    return res.json(rows[0]);

  } catch (e: any) {
    console.error("GET /api/bookings/by-session failed:", e?.message || e);
    return res.status(500).json({ error: "Server error" });
  } finally {
    try {
      if (client) await client.end();
    } catch {}
  }
});

// ANCHOR: BOOKINGS_RECEIPT_PDF (LIVE)

app.get("/api/bookings/receipt.pdf", async (req: Request, res: Response) => {
  let client: Client | null = null;

  try {
    const sessionId = String(req.query.session_id || "").trim();
    if (!sessionId) return res.status(400).json({ error: "Missing session_id" });

    const cs = process.env.DATABASE_URL as string;
    if (!cs) return res.status(500).json({ error: "Missing DATABASE_URL" });

    client = new Client({
      connectionString: cs,
      ssl: wantsSSL(cs) ? { rejectUnauthorized: false } : undefined,
    });

    await client.connect();

    // Pull the booking. Expand this SELECT later once Booking has property/stay snapshot fields.
    const { rows } = await client.query(
      `
      SELECT
        "bookingRef",
        status,
        "pendingConfirmExpiresAt",
        "refundDeadlineAt",
        "createdAt",
        "providerPaymentId"
      FROM extranet."Booking"
      WHERE "providerPaymentId" = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [sessionId]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const b = rows[0];
    // Timezone for formatting (passed from browser as IANA tz, ex: America/New_York)
    const tz = String(req.query.tz || "UTC").trim() || "UTC";

    function fmtInTz(d: any) {
      if (!d) return "-";
      const dt = new Date(d);
      if (!Number.isFinite(dt.getTime())) return "-";

      // Example output: "12/27/2025, 09:17 PM EST"
      return dt.toLocaleString("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
        timeZoneName: "short",
      });
    }

    // Lazy import so server still boots if something goes wrong in install
    // but you should still install pdfkit.
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="Lolaelo_Receipt_${b.bookingRef || "booking"}.pdf"`
    );

    const doc = new PDFDocument({ size: "LETTER", margin: 54 });
    doc.pipe(res);

    // Header: logo + title
    const logoPath = path.join(process.cwd(), "public", "images", "logo.png");

    // Make logo much larger (approx 7x the prior 32px feel), but keep it clean
    const logoW = 140;              // keep width the same
    const logoH = 85;              // ~2.5x previous height (40 → 100)
    const headerX = 54;
    const headerY = 38;             // slightly higher to balance taller logo

    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, headerX, headerY, { width: logoW, height: logoH });
    }

    // Re-align Receipt vertically to center against taller logo
    doc
      .fillColor("#ff6a3d")
      .fontSize(22)
      .text("Receipt", headerX + logoW + 14, headerY + logoH / 2 - 10);

    doc.fillColor("#0f172a");
    doc.moveDown(2.2);

    doc.fontSize(12).fillColor("#475569").text("Booking receipt (pending hotel confirmation).");
    doc.fillColor("#0f172a");
    doc.moveDown(1);

    // Key fields
    doc.fontSize(12).text(`Booking reference: ${b.bookingRef || "-"}`);
    doc.text(`Status: ${(b.status || "-").replaceAll("_", " ")}`);
    doc.text(`Booked on: ${fmtInTz(b.createdAt)}`);
    doc.text(`Hotel confirmation window ends: ${fmtInTz(b.pendingConfirmExpiresAt)}`);
    doc.moveDown(1);

    doc.fillColor("#475569").fontSize(11).text(`Stripe session: ${b.providerPaymentId || "-"}`);
    doc.fillColor("#0f172a");
    doc.moveDown(1);

    doc.fontSize(11).fillColor("#475569").text(
      "Note: If the hotel does not confirm within the 24 hour window, Lolaelo will automatically begin the refund process. Refunds are initiated within 48 hours after the confirmation window expires, or after the hotel declines the booking."
    );

    doc.end();
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e);
    const stack = e?.stack ? String(e.stack) : "";

    console.error("GET /api/bookings/receipt.pdf failed:", msg);
    if (stack) console.error(stack);

    if (!res.headersSent) {
      return res.status(500).json({
        error: "Server error",
        detail: msg,
      });
    }
  } finally {
    try {
      if (client) await client.end();
    } catch {}
  }
  });

// ---- Health ----
app.get("/health", (_req, res) => {
  res.type("text/plain").send("OK v-ROUTES-32 BYSESSION-ON");
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
// await tryMount("./routes/extranetUisMock.js", "/extranet/pms"); // optional mock route (disabled)
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
    const roomId = req.query.roomId != null ? Number(req.query.roomId) : undefined;
    const plans  = req.query.plans  != null ? Number(req.query.plans)  : undefined;

    const payload = await getDetailsFromAdapter({
      propertyId,
      start,
      end,
      ratePlanId,
      roomId,
      plans,
    }) ?? null;

    if (!payload) {
      res.status(404).json({ ok: false, error: "Not found" });
      return;
    }
    res.setHeader("x-lolaelo-details-build", "plans-roomid-gated-v1");
    (payload as any)._detailsRouteFingerprint = "catalog_details_route_v1";
    (payload as any)._detailsRoutePlans = plans;
    (payload as any)._detailsRouteRoomId = roomId;
    (payload as any)._detailsRouteRatePlanId = ratePlanId;

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

// ANCHOR: STRIPE_CREATE_CHECKOUT_SESSION
app.post("/api/payments/create-checkout-session", async (req: Request, res: Response) => {
  try {
    const body: any = req.body || {};

    const currency = "usd";

    const totalCentsRaw =
      body.totalCents != null ? Number(body.totalCents) :
      body.amountTotal != null ? Math.round(Number(body.amountTotal) * 100) :
      NaN;

    const totalCents = Number.isFinite(totalCentsRaw) ? Math.trunc(totalCentsRaw) : NaN;

    if (!Number.isFinite(totalCents) || totalCents <= 0) {
      return res.status(400).json({
        error: "invalid_total",
        message: "Missing or invalid total for Stripe Checkout Session (totalCents or amountTotal required).",
      });
    }

    const travelerFirstName = String(body.travelerFirstName || "").trim();
    const travelerLastName = String(body.travelerLastName || "").trim();
    const travelerEmail = String(body.travelerEmail || "").trim();
    const travelerPhone = String(body.travelerPhone || "").trim();

    const metadata: Record<string, string> = {
      travelerFirstName: String(body.travelerFirstName || "").trim(),
      travelerLastName:  String(body.travelerLastName || "").trim(),
      travelerEmail:     String(body.travelerEmail || "").trim(),
      travelerPhone:     String(body.travelerPhone || "").trim(),
      totalCents:        String(Math.trunc(totalCents)),
      currency:          "usd",
    };

    if (body.guestsCount != null) metadata.guestsCount = String(body.guestsCount);
    else if (body.guests != null) metadata.guestsCount = String(body.guests);

    if (body.bookingRef) metadata.bookingRef = String(body.bookingRef);
    if (body.partnerId) metadata.partnerId = String(body.partnerId);
    if (body.roomTypeId) metadata.roomTypeId = String(body.roomTypeId);
    if (body.ratePlanId) metadata.ratePlanId = String(body.ratePlanId);
    if (body.checkInDate) metadata.checkInDate = String(body.checkInDate);
    if (body.checkOutDate) metadata.checkOutDate = String(body.checkOutDate);
    if (body.qty != null) metadata.qty = String(body.qty);
    // cartItems: store as JSON string (Stripe metadata values must be strings)
    if (Array.isArray(body.cartItems) && body.cartItems.length) {
      // keep it small to avoid metadata limits
      const compact = body.cartItems.slice(0, 20).map((it: any) => ({
        roomTypeId: Number(it.roomTypeId || 0),
        ratePlanId: Number(it.ratePlanId || 0),
        checkInDate: String(it.checkInDate || ""),
        checkOutDate: String(it.checkOutDate || ""),
        qty: Number(it.qty || 1),
        currency: String(it.currency || metadata.currency || "USD"),
        lineTotal: Number(it.lineTotal || 0)
      }));
      metadata.cartItems = JSON.stringify(compact);
    }

    // addons: store as JSON string (Stripe metadata values must be strings)
    if (Array.isArray(body.addons) && body.addons.length) {
      const compactAddons = body.addons.slice(0, 30).map((a: any) => {
        const activity = String(a.activity || "").trim();
        const uom = String(a.uom || "").trim();

        return {
          addOnId: 0, // resolved in webhook using DB lookup
          activity,
          uom,
          unitPrice: Number(a.unitPrice ?? a.price ?? 0),
          qty: Number(a.qty ?? a.quantity ?? 1),
          currency: String(a.currency || metadata.currency || "USD"),
          lineTotal: Number(a.lineTotal || 0),
          comment: String(a.travelerComment || a.comment || "")
        };
      });

      metadata.addons = JSON.stringify(compactAddons);

      const summary = compactAddons
        .filter((x: any) => x.activity)
        .map((x: any) => `${x.activity}${x.qty > 1 ? ` x${x.qty}` : ""}`)
        .join(", ")
        .slice(0, 490);

      if (summary) metadata.addonsSummary = summary;
    }

    // legacy fields for checkout_success rendering
    if (body.propertyId) metadata.propertyId = String(body.propertyId);
    if (body.roomId) metadata.roomId = String(body.roomId);
    if (body.start) metadata.start = String(body.start);
    if (body.end) metadata.end = String(body.end);
    if (body.propertyName) metadata.propertyName = String(body.propertyName);
    if (body.roomName) metadata.roomName = String(body.roomName);
    if (body.ratePlanName) metadata.ratePlanName = String(body.ratePlanName);

    const base = process.env.PUBLIC_BASE_URL || "https://lolaelo-api.onrender.com";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: travelerEmail || undefined,
      line_items: [
        {
          price_data: {
            currency,
            product_data: { name: "Lolaelo booking" },
            unit_amount: totalCents,
          },
          quantity: 1,
        },
      ],
      success_url: `${base}/checkout_success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/checkout.html?canceled=1`,
      metadata,
    });

    // ANCHOR: CARTITEMS_METADATA_DEBUG
    console.log("[create-checkout-session] metadata keys:", Object.keys(metadata || {}));
    console.log("[create-checkout-session] cartItems bytes:", metadata.cartItems ? Buffer.byteLength(String(metadata.cartItems), "utf8") : 0);
    // ANCHOR: CARTITEMS_METADATA_DEBUG END

    return res.json({ ok: true, url: session.url || "", id: session.id });
  } catch (e) {
    console.error("[create-checkout-session] failed:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});
// ANCHOR: STRIPE_CREATE_CHECKOUT_SESSION END

export default app;
