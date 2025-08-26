import { Router, type Request, type Response } from "express";
import { prisma } from "../prisma.js";
import crypto from "crypto";

// ===== Config =====
const CODE_TTL_MINUTES = 10;
const SESSION_TTL_DAYS = 30;
// Optional: add a pepper for hashing OTP codes (set in env, or leave blank for dev)
const CODE_PEPPER = process.env.CODE_PEPPER || "";

// ===== Helpers =====
function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function sha256(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function makeCode(): string {
  // 6-digit numeric code
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function makeToken(): string {
  return "sess_" + crypto.randomBytes(24).toString("hex");
}

function nowPlusMinutes(m: number) {
  return new Date(Date.now() + m * 60 * 1000);
}

function nowPlusDays(d: number) {
  return new Date(Date.now() + d * 24 * 60 * 60 * 1000);
}

// ===== Router =====
const router = Router();

/**
 * POST /extranet/login/request-code
 * Body: { email }
 * Returns: { email, code }  (dev convenience; in prod, email the code)
 */
router.post("/login/request-code", async (req: Request, res: Response) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ message: "email required" });

    const normEmail = normalizeEmail(email);

    // Ensure a Partner row exists
    const partner = await prisma.partner.upsert({
      where: { email: normEmail },
      update: {},
      create: { email: normEmail, name: null },
    });

    const code = makeCode();
    const codeHash = sha256(CODE_PEPPER + code);

    // Create a new code; old ones remain but will expire naturally
    await prisma.extranetLoginCode.create({
      data: {
        partnerId: partner.id,
        codeHash,
        expiresAt: nowPlusMinutes(CODE_TTL_MINUTES),
      },
    });

    // DEV: return the code in clear text; remove in production
    return res.json({ email: normEmail, code });
  } catch (err) {
    console.error("request-code error", err);
    return res.status(500).json({ message: "internal error" });
  }
});

/**
 * POST /extranet/login
 * Body: { email, code }
 * Returns: { token }
 * Notes: we only support the code-based flow here.
 */
router.post("/login", async (req: Request, res: Response) => {
  try {
    const { email, code } = req.body || {};
    if (!email || !code) return res.status(400).json({ message: "Email and code required." });

    const normEmail = normalizeEmail(email);

    // Look up partner
    const partner = await prisma.partner.findUnique({ where: { email: normEmail } });
    if (!partner) return res.status(401).json({ message: "partner not found" });

    // Fetch latest valid code for this partner
    const latest = await prisma.extranetLoginCode.findFirst({
      where: {
        partnerId: partner.id,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!latest) return res.status(401).json({ message: "no valid code on record (request a new one)" });

    const incomingHash = sha256(CODE_PEPPER + String(code));
    if (incomingHash !== latest.codeHash) {
      return res.status(401).json({ message: "invalid code" });
    }

    // Mark code used
    await prisma.extranetLoginCode.update({
      where: { id: latest.id },
      data: { usedAt: new Date() },
    });

    // Create a new session
    const token = makeToken();
    const expiresAt = nowPlusDays(SESSION_TTL_DAYS);

    await prisma.extranetSession.create({
      data: {
        partnerId: partner.id,
        token,
        expiresAt,
      },
    });

    return res.json({ token });
  } catch (err) {
    console.error("login error", err);
    return res.status(500).json({ message: "internal error" });
  }
});

/**
 * GET /extranet/session
 * Header: Authorization: Bearer <token>   (or x-partner-token: <token> for legacy)
 * Returns: { partnerId, email, name, expiresAt }
 */
router.get("/session", async (req: Request, res: Response) => {
  try {
    const auth = req.header("authorization") || req.header("Authorization");
    const legacy = req.header("x-partner-token");
    let token: string | null = null;

    if (auth && auth.startsWith("Bearer ")) token = auth.slice("Bearer ".length).trim();
    else if (legacy) token = legacy.trim();

    if (!token) return res.status(401).json({ message: "missing token" });

    const session = await prisma.extranetSession.findUnique({ where: { token } });
    if (!session) return res.status(401).json({ message: "session not found" });
    if (session.revokedAt) return res.status(401).json({ message: "session revoked" });
    if (session.expiresAt && session.expiresAt < new Date()) return res.status(401).json({ message: "session expired" });

    const partner = await prisma.partner.findUnique({ where: { id: session.partnerId } });
    if (!partner) return res.status(401).json({ message: "partner not found" });

    return res.json({
      partnerId: partner.id,
      email: partner.email,
      name: partner.name,
      expiresAt: session.expiresAt,
    });
  } catch (err) {
    console.error("session error", err);
    return res.status(500).json({ message: "internal error" });
  }
});

export default router;
