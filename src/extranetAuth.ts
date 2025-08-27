// src/extranetAuth.ts
import crypto from "crypto";
import { prisma } from "./prisma.js";
import { sendLoginCodeEmail } from "./mailer.js";

const CODE_TTL_MINUTES = 10;   // OTP validity
const SESSION_TTL_DAYS = 30;   // session validity

// When true, API responses will include the plaintext code (dev only)
const DEV_SHOW_CODE =
  String(process.env.EXTRANET_DEV_SHOW_CODE || "false").toLowerCase() === "true";

// Where the email “Sign in” button should point.
// Render can override via APP_LOGIN_URL.
const APP_LOGIN_URL =
  process.env.APP_LOGIN_URL || "https://www.lolaelo.com/travel/partners_login.html";

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function generateNumericCode(): string {
  const n = Math.floor(Math.random() * 1_000_000);
  return n.toString().padStart(6, "0"); // 6 digits, leading zeros allowed
}

function randomToken(): string {
  return crypto.randomBytes(32).toString("hex"); // 64-char hex
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Create a one-time 6-digit code, store only its hash, email the
 * plaintext code to the user, and (optionally) return it to the caller
 * when DEV flag is on.
 */
export async function requestLoginCode(email: string) {
  const normalized = normalizeEmail(email);
  if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("Invalid email");
  }

  // Ensure partner exists
  const partner = await prisma.partner.upsert({
    where: { email: normalized },
    update: {},
    create: { email: normalized },
  });

  // Create code
  const code = generateNumericCode();
  const codeHash = sha256(code);
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);

  await prisma.extranetLoginCode.create({
    data: { partnerId: partner.id, codeHash, expiresAt },
  });

  // Fire-and-forget email; don't block the API on email latency.
  try {
    // Pass login URL explicitly so the template always has the right link
    await sendLoginCodeEmail(partner.email, code);
  } catch (e) {
    console.warn("[auth] sendLoginCodeEmail failed:", e);
  }

  return {
    partnerId: partner.id,
    email: partner.email,
    expiresAt,
    code: DEV_SHOW_CODE ? code : undefined, // returned only in dev
  };
}

/**
 * Verify the code and create a new session token.
 */
export async function verifyLoginCode(email: string, code: string) {
  const normalized = normalizeEmail(email);
  const codeHash = sha256((code || "").trim());

  const partner = await prisma.partner.findUnique({ where: { email: normalized } });
  if (!partner) throw new Error("Partner not found");

  const now = new Date();
  const loginCode = await prisma.extranetLoginCode.findFirst({
    where: { partnerId: partner.id, codeHash, usedAt: null, expiresAt: { gt: now } },
    orderBy: { id: "desc" },
  });

  if (!loginCode) throw new Error("Invalid or expired code");

  // Mark as used
  await prisma.extranetLoginCode.update({
    where: { id: loginCode.id },
    data: { usedAt: now },
  });

  // Create session
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  const session = await prisma.extranetSession.create({
    data: { partnerId: partner.id, token, expiresAt },
  });

  return {
    token: session.token,
    expiresAt: session.expiresAt,
    partner: { id: partner.id, email: partner.email, name: partner.name ?? null },
  };
}

/**
 * Extract partner from request headers.
 * Accepts either Authorization: Bearer <token> or x-partner-token: <token>.
 */
export async function authPartnerFromHeader(req: { header: (k: string) => string | undefined }) {
  const auth = req.header("authorization") || req.header("Authorization");
  const legacy = req.header("x-partner-token") || req.header("X-Partner-Token");

  let token: string | null = null;
  if (auth && auth.startsWith("Bearer ")) token = auth.slice("Bearer ".length).trim();
  else if (legacy) token = legacy.trim();

  if (!token) return null;

  const now = new Date();
  const session = await prisma.extranetSession
    .findUnique({ where: { token }, include: { partner: true } })
    .catch(() => null);

  if (!session || session.revokedAt || session.expiresAt <= now) return null;
  return session.partner ?? null;
}
