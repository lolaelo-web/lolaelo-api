import crypto from "crypto";

// ----- Simple in-memory stores (replace with DB later) ----------------------
type CodeItem = { code: string; expiresAt: number };
type SessionItem = { email: string; name: string; partnerId: number; expiresAt: number };
type Property = {
  name: string | null; contactEmail: string | null; phone: string | null;
  country: string | null; addressLine: string | null; city: string | null;
  description: string | null;
};

const CODE_TTL_MIN = 10;
const SESSION_TTL_DAYS = 30;

const codes = new Map<string, CodeItem>();              // key: email
const sessions = new Map<string, SessionItem>();        // key: token
const properties = new Map<string, Property>();         // key: email

const now = () => Date.now();
const addMin = (ms:number, m:number) => ms + m*60_000;
const addDays = (ms:number, d:number) => ms + d*86_400_000;
const uuid = () => crypto.randomUUID();

function nameFromEmail(email: string): string {
  const base = email.split("@")[0] || "Partner";
  return base
    .split(/[.\-_ ]+/).filter(Boolean)
    .map(s => s[0]?.toUpperCase() + s.slice(1))
    .join(" ");
}
function idFromEmail(email: string): number {
  let h = 0;
  for (let i=0;i<email.length;i++) h = ((h<<5)-h) + email.charCodeAt(i) | 0;
  return Math.abs(h) % 10_000_000;
}

// ----- OTP -------------------------------------------------------------------
export function issueCode(email: string) {
  const e = email.trim().toLowerCase();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  codes.set(e, { code, expiresAt: addMin(now(), CODE_TTL_MIN) });
  return { email: e, code, ttlMin: CODE_TTL_MIN };
}

export function verifyCodeIssueSession(email: string, code: string) {
  const e = email.trim().toLowerCase();
  const item = codes.get(e);
  if (!item) return null;
  if (item.expiresAt < now()) { codes.delete(e); return null; }
  if (item.code !== code) return null;

  codes.delete(e);
  const token = uuid();
  const sess: SessionItem = {
    email: e,
    name: nameFromEmail(e),
    partnerId: idFromEmail(e),
    expiresAt: addDays(now(), SESSION_TTL_DAYS),
  };
  sessions.set(token, sess);
  return { token, expiresAt: sess.expiresAt, session: sess };
}

export function getSession(token?: string | null) {
  const t = (token || "").trim();
  if (!t) return null;
  const s = sessions.get(t);
  if (!s) return null;
  if (s.expiresAt < now()) { sessions.delete(t); return null; }
  return s;
}
export function deleteSession(token?: string | null) {
  if (token) sessions.delete(token);
}

// ----- Property profile ------------------------------------------------------
export function getProperty(email: string): Property {
  const e = email.trim().toLowerCase();
  if (!properties.has(e)) {
    properties.set(e, {
      name: null, contactEmail: null, phone: null,
      country: null, addressLine: null, city: null, description: null
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

// ----- Auth helper for routes -----------------------------------------------
import type { Request, Response, NextFunction } from "express";
export async function authPartnerFromHeader(req: Request, res: Response, next: NextFunction) {
  try {
    const hdr = (req.headers["authorization"] as string) || "";
    const bearer = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
    const token = (req.headers["x-partner-token"] as string) || bearer || "";
    const s = getSession(token);
    if (!s) return res.status(401).json({ error: "Unauthorized" });
    (req as any).partner = { id: s.partnerId, email: s.email, name: s.name };
    (req as any).partnerToken = token;
    return next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}
