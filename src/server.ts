// src/server.ts
import express from "express";
import cors from "cors";
import { prisma } from "./prisma.js";
import { requestLoginCode, verifyLoginCode, authPartnerFromHeader } from "./extranetAuth.js";

const app = express();
app.use(express.json());

// CORS (adjust origins as needed)
app.use(
  cors({
    origin: [
      "https://www.lolaelo.com",
      "https://lolaelo.com",
      "http://localhost:3000",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ],
    credentials: false,
  })
);

// --- Admin key guard (existing) ---
const ADMIN_KEY = process.env.ADMIN_KEY || "L0laEl0_Admin_2025!";

function requireAdmin(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  if (req.header("x-admin-key") !== ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// --- Health ---
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// --- Anti-bot helper for public POSTs (honeypot) ---
function isBotSubmission(body: any): boolean {
  return !!(body && typeof body._gotcha === "string" && body._gotcha.trim() !== "");
}

// =========================
// Public endpoints (existing)
// =========================

// Waitlist
app.post("/waitlist", async (req, res) => {
  if (isBotSubmission(req.body)) return res.status(204).end();
  const { email, phone } = req.body || {};
  if (!email) return res.status(400).json({ error: "email required" });
  const row = await prisma.waitlist.create({ data: { email, phone: phone ?? null } });
  res.json({ id: row.id });
});

app.get("/waitlist", requireAdmin, async (_req, res) => {
  const rows = await prisma.waitlist.findMany({ orderBy: { createdAt: "desc" } });
  res.json(rows);
});

// Partner applications
app.post("/partners/applications", async (req, res) => {
  if (isBotSubmission(req.body)) return res.status(204).end();
  const { companyName, contactName, email, phone, location, notes } = req.body || {};
  if (!companyName || !contactName || !email) {
    return res.status(400).json({ error: "companyName, contactName, email required" });
  }
  const row = await prisma.partnerApplication.create({
    data: { companyName, contactName, email, phone: phone ?? null, location: location ?? null, notes: notes ?? null },
  });
  res.json({ id: row.id });
});

app.get("/partners/applications", requireAdmin, async (_req, res) => {
  const rows = await prisma.partnerApplication.findMany({ orderBy: { createdAt: "desc" } });
  res.json(rows);
});

// Content blocks
app.put("/content/:key", requireAdmin, async (req, res) => {
  const key = req.params.key;
  const { value } = req.body || {};
  if (typeof value !== "string") return res.status(400).json({ error: "value must be string" });
  const row = await prisma.contentBlock.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
  res.json({ key: row.key, updatedAt: row.updatedAt });
});

app.get("/content/:key", async (req, res) => {
  const key = req.params.key;
  const row = await prisma.contentBlock.findUnique({ where: { key } });
  res.json(row?.value ?? "");
});

// =========================
/** Admin CSV exports (optional) */
// =========================
app.get("/admin/export/waitlist.csv", requireAdmin, async (_req, res) => {
  const rows = await prisma.waitlist.findMany({ orderBy: { createdAt: "desc" } });
  const header = "email,phone,createdAt\n";
  const body = rows.map(r => `${r.email},${r.phone ?? ""},${r.createdAt.toISOString()}`).join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.send(header + body);
});

app.get("/admin/export/partners.csv", requireAdmin, async (_req, res) => {
  const rows = await prisma.partnerApplication.findMany({ orderBy: { createdAt: "desc" } });
  const header = "companyName,contactName,email,phone,location,notes,createdAt\n";
  const body = rows.map(r =>
    [r.companyName, r.contactName, r.email, r.phone ?? "", r.location ?? "", (r.notes ?? "").replace(/\n/g, " "), r.createdAt.toISOString()]
      .map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")
  ).join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.send(header + body);
});

// =========================
// EXTRANET AUTH
// =========================

// Request login code (conditional dev code in response)
app.post("/extranet/login/request-code", async (req, res) => {
  const { email } = req.body || {};
  try {
    const result = await requestLoginCode(String(email || ""));
    res.json({
      ok: true,
      email: result.email,
      expiresAt: result.expiresAt,
      // Only included when EXTRANET_DEV_SHOW_CODE=true
      ...(result.code ? { code: result.code } : {}),
      message: result.code
        ? "Dev only: code is shown here"
        : "Check your email for the 6-digit code",
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "Unable to request code" });
  }
});

// Verify code and get session token
app.post("/extranet/login/verify", async (req, res) => {
  const { email, code } = req.body || {};
  try {
    const result = await verifyLoginCode(String(email || ""), String(code || ""));
    res.json({
      ok: true,
      token: result.token,
      expiresAt: result.expiresAt,
      partner: result.partner,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "Invalid or expired code" });
  }
});

// Helper middleware for partner-protected routes
async function requirePartner(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const partner = await authPartnerFromHeader(req as any);
  if (!partner) return res.status(401).json({ error: "Unauthorized" });
  // @ts-ignore
  req.partner = partner;
  next();
}

// Who am I
app.get("/extranet/me", requirePartner, async (req, res) => {
  // @ts-ignore
  const partner = req.partner as { id: number; email: string | null; name?: string | null };
  res.json({ id: partner.id, email: partner.email, name: partner.name ?? null });
});

// Alias used by frontend session check
app.get("/extranet/session", requirePartner, async (req, res) => {
  // @ts-ignore
  const partner = req.partner as { id: number; email: string | null; name?: string | null };
  res.json({ id: partner.id, email: partner.email, name: partner.name ?? null });
});

// --- Revoke the current session token ---
app.post("/extranet/logout", requirePartner, async (req, res) => {
  // Pull token from headers to revoke *this* session
  const auth = req.header("authorization") || req.header("Authorization");
  const legacy = req.header("x-partner-token");
  let token: string | null = null;
  if (auth && auth.startsWith("Bearer ")) token = auth.slice("Bearer ".length).trim();
  else if (legacy) token = String(legacy).trim();

  if (token) {
    await prisma.extranetSession
      .update({ where: { token }, data: { revokedAt: new Date() } })
      .catch(() => null);
  }
  res.json({ ok: true });
});

// =========================
// EXTRANET PROPERTY PROFILE
// =========================

// GET current partner's Property Profile
app.get("/extranet/property", requirePartner, async (req, res) => {
  // @ts-ignore
  const partner = req.partner as { id: number };
  const profile = await prisma.propertyProfile.findUnique({
    where: { partnerId: partner.id },
  });
  if (!profile) return res.status(404).json({ message: "No profile yet" });
  res.json(profile);
});

// CREATE/UPDATE current partner's Property Profile
app.put("/extranet/property", requirePartner, async (req, res) => {
  // @ts-ignore
  const partner = req.partner as { id: number };

  const {
    name,
    addressLine = null,
    city = null,
    country = null,
    contactEmail = null,
    phone = null,
    description = null,
  } = req.body || {};

  if (!name || typeof name !== "string" || name.trim().length < 2) {
    return res.status(400).json({ message: "Property name is required" });
  }

  const data = {
    partnerId: partner.id,
    name: name.trim(),
    addressLine,
    city,
    country,
    contactEmail,
    phone,
    description,
  };

  const saved = await prisma.propertyProfile.upsert({
    where: { partnerId: partner.id },
    update: { ...data },
    create: { ...data },
  });

  res.json(saved);
});

// =========================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});
