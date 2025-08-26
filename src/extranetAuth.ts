// src/extranetAuth.ts
import crypto from "crypto";
import { prisma } from "./prisma.js";

const CODE_TTL_MINUTES = 10;
const SESSION_TTL_DAYS = 30;

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function generateNumericCode(): string {
  // 6-digit numeric code, leading zeros allowed
  const n = Math.floor(Math.random() * 1_000_000);
  return n.toString().padStart(6, "0");
}

function randomToken(): string {
  return crypto.randomBytes(32).toString("hex"); // 64-char hex
}

export async function requestLoginCode(email: string) {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("Invalid email");
  }

  // Ensure partner exists
  const partner = await prisma.partner.upsert({
    where: { email: normalized },
    update: {},
    create: { email: normalized },
  });

  // Generate new code
  const code = generateNumericCode();
  const codeHash = sha256(code);
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);

  await prisma.extranetLoginCode.create({
    data: {
      partnerId: partner.id,
      codeHash,
      expiresAt,
    },
  });

  // TODO: Send this code by email (Postmark/Sendgrid). For now we return it for testing.
  return { partnerId: partner.id, email: partner.email, code, expiresAt };
}

export async function verifyLoginCode(email: string, code: string) {
  const normalized = email.trim().toLowerCase();
  const codeHash = sha256(code.trim());

  const partner = await prisma.partner.findUnique({
    where: { email: normalized },
  });
  if (!partner) throw new Error("Partner not found");

  // Find the most recent valid code
  const now = new Date();
  const loginCode = await prisma.extranetLoginCode.findFirst({
    where: {
      partnerId: partner.id,
      codeHash,
      usedAt: null,
      expiresAt: { gt: now },
    },
    orderBy: { id: "desc" },
  });

  if (!loginCode) {
    throw new Error("Invalid or expired code");
  }

  // Mark code as used
  await prisma.extranetLoginCode.update({
    where: { id: loginCode.id },
    data: { usedAt: now },
  });

  // Create session
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  const session = await prisma.extranetSession.create({
    data: {
      partnerId: partner.id,
      token,
      expiresAt,
    },
  });

  return {
    token: session.token,
    expiresAt: session.expiresAt,
    partner: { id: partner.id, email: partner.email, name: partner.name ?? null },
  };
}

export async function authPartnerFromHeader(req: { header: (k: string) => string | undefined }) {
  const token = (req.header("x-partner-token") || "").trim();
  if (!token) return null;

  const now = new Date();
  const session = await prisma.extranetSession.findUnique({
    where: { token },
    include: { partner: true },
  });
  if (!session || session.revokedAt || session.expiresAt <= now) return null;

  return session.partner;
}
