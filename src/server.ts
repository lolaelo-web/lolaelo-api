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

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
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
/* Admin CSV exports (optional; keep if already added) */
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
// EXTRANET AUTH (existing)
// =========================

// Request login code (magic 6-digit code sent to email; returns code in response for testing)
app.post("/extranet/login/request-code", async (req, res) => {
  const { email } = req.body || {};
  try {
    const result = await requestLoginCode(String(email || ""));
    // NOTE: In production, do NOT return the code. Email it instead.
    res.json({
      ok: true,
      email: result.email,
      code: result.code,
      expiresAt: result.expiresAt,
      message: "Use /extranet/login/verify with email + code",
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
async function requirePartner(req: express.Request, res: express.Response, next: express.NextFunction) {
  const partner = await authPartnerFromHeader(req);
  if (!partner) return res.status(401).json({ error: "Unauthorized" });
  // @ts-ignore
  req.partner = partner;
  next();
}

// Simple "who am I" check (partner-protected)
app.get("/extranet/me", requirePartner, async (req, res) => {
  // @ts-ignore
  const partner = req.partner as { id: number; email: string | null; name?: string | null };
  res.json({ id: partner.id, email: partner.email, name: partner.name ?? null });
});

// === NEW: Alias used by frontend session check ===
app.get("/extranet/session", requirePartner, async (req, res) => {
  // @ts-ignore
  const partner = req.partner as { id: number; email: string | null; name?: string | null };
  res.json({ id: partner.id, email: partner.email, name: partner.name ?? null });
});

// =========================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});
