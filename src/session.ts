import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ----- Simple stores (OTP codes + property profile stay in-memory) ------------
type CodeItem = { code: string; expiresAt: number };
type SessionItem = { email: string; name: string; partnerId: number; expiresAt: number };
type Property = {
  name: string | null;
  contactEmail: string | null;
  phone: string | null;
  country: string | null;
  addressLine: string | null;
  city: string | null;
  description: string | null;
};

const CODE_TTL_MIN = 10;
const SESSION_TTL_DAYS = 30;

const codes = new Map<string, CodeItem>();       // key: email
const properties = new Map<string, Property>(); // key: email

const now = () => Date.now();
const addMin  = (ms: number, m: number) => ms + m * 60_000;
const addDays = (ms: number, d: number) => ms + d * 86_400_000;
const uuid = () => crypto.randomUUID();

function nameFromEmail(email: string): string {
  const base = email.split("@")[0] || "Partner";
  return base
    .split(/[.\-_ ]+/)
    .filter(Boolean)
    .map(s => s[0]?.toUpperCase() + s.slice(1))
    .join(" ");
}

// ----- OTP -------------------------------------------------------------------
export function issueCode(email: string) {
  const e = email.trim().toLowerCase();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  codes.set(e, { code, expiresAt: addMin(now(), CODE_TTL_MIN) });
  return { email: e, code, ttlMin: CODE_TTL_MIN };
}

// ----- Verify OTP and issue session -----------------------------------------
export async function verifyCodeIssueSession(email: string, code: string) {
  const e = email.trim().toLowerCase();
  const item = codes.get(e);
  if (!item) return null;
  if (item.expiresAt < now()) { codes.delete(e); return null; }
  if (item.code !== code) return null;

  // OTP ok — clear it
  codes.delete(e);

  // Partner MUST already exist (admin-provisioned)
  const partner = await prisma.extranet_Partner.findUnique({
    where: { email: e }
  });
  if (!partner) return null;
  if (!partner.passwordHash) return null;

  const token = uuid();
  const expDate = new Date(addDays(now(), SESSION_TTL_DAYS));

  // Create session in STORAGE table
  await prisma.$executeRaw`
    INSERT INTO extranet."ExtranetSession"
      ("partnerId", token, "expiresAt", "createdAt", "lastSeenAt")
    VALUES
      (${partner.id}, ${token}, ${expDate}, now(), now())
  `;

  return {
    token,
    expiresAt: expDate.getTime(),
    session: {
      email: e,
      name: partner.name ?? nameFromEmail(e),
      partnerId: partner.id,
      expiresAt: expDate.getTime(),
    } as SessionItem,
  };
}

// ----- Fetch session by token ------------------------------------------------
export async function getSession(token?: string | null) {
  const t = (token || "").trim();
  if (!t) return null;

  const rows = await prisma.$queryRaw<any[]>`
    SELECT
      s.token,
      s."partnerId",
      s."expiresAt",
      s."createdAt",
      s."revokedAt",
      p.email,
      p.name
    FROM extranet."ExtranetSession" s
    JOIN extranet."Partner" p ON p.id = s."partnerId"
    WHERE s.token = ${t}
    LIMIT 1
  `;

  const s = rows?.[0];
  if (!s) return null;

  if (s.expiresAt && new Date(s.expiresAt) < new Date()) {
    await prisma.$executeRaw`
      UPDATE extranet."ExtranetSession"
      SET "revokedAt" = now()
      WHERE token = ${t}
    `;
    return null;
  }

  return {
    email: s.email,
    name: s.name ?? nameFromEmail(s.email),
    partnerId: s.partnerId,
    expiresAt: new Date(s.expiresAt).getTime(),
  } as SessionItem;
}

// ----- Revoke session --------------------------------------------------------
export async function deleteSession(token?: string | null) {
  const t = (token || "").trim();
  if (!t) return;
  await prisma.$executeRaw`
    UPDATE extranet."ExtranetSession"
    SET "revokedAt" = now()
    WHERE token = ${t}
  `;
}

// ----- Property profile (in-memory scratch) ----------------------------------
export function getProperty(email: string): Property {
  const e = email.trim().toLowerCase();
  if (!properties.has(e)) {
    properties.set(e, {
      name: null,
      contactEmail: null,
      phone: null,
      country: null,
      addressLine: null,
      city: null,
      description: null,
    });
  }
  return properties.get(e)!;
}

export function saveProperty(email: string, data: Partial<Property>) {
  const cur = getProperty(email);
  const next: Property = { ...cur, ...data };
  properties.set(email.trim().toLowerCase(), next);
  return next;
}

// ----- Auth helper for routes ------------------------------------------------
export async function authPartnerFromHeader(req: Request, res: Response, next: NextFunction) {
  try {
    const hdr = (req.headers["authorization"] as string) || "";
    const bearer = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
    const token  = (req.headers["x-partner-token"] as string) || bearer || "";

    const s = await getSession(token);
    if (!s) return res.status(401).json({ error: "Unauthorized" });

    (req as any).partner = { id: s.partnerId, email: s.email, name: s.name };
    (req as any).partnerToken = token;
    return next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}
