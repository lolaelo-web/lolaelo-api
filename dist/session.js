import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const CODE_TTL_MIN = 10;
const SESSION_TTL_DAYS = 30;
const codes = new Map(); // key: email (OTP codes)
const properties = new Map(); // key: email (profile draft cache)
const now = () => Date.now();
const addMin = (ms, m) => ms + m * 60_000;
const addDays = (ms, d) => ms + d * 86_400_000;
const uuid = () => crypto.randomUUID();
function nameFromEmail(email) {
    const base = email.split("@")[0] || "Partner";
    return base
        .split(/[.\-_ ]+/).filter(Boolean)
        .map(s => s[0]?.toUpperCase() + s.slice(1))
        .join(" ");
}
// ----- OTP -------------------------------------------------------------------
export function issueCode(email) {
    const e = email.trim().toLowerCase();
    const code = String(Math.floor(100000 + Math.random() * 900000));
    codes.set(e, { code, expiresAt: addMin(now(), CODE_TTL_MIN) });
    return { email: e, code, ttlMin: CODE_TTL_MIN };
}
// Create/refresh a DB session after OTP verification
export async function verifyCodeIssueSession(email, code) {
    const e = email.trim().toLowerCase();
    const item = codes.get(e);
    if (!item)
        return null;
    if (item.expiresAt < now()) {
        codes.delete(e);
        return null;
    }
    if (item.code !== code)
        return null;
    // OTP ok — clear it
    codes.delete(e);
    // Ensure Partner exists (id, email, name)
    const partner = await prisma.partner.upsert({
        where: { email: e },
        update: { updatedAt: new Date() },
        create: { email: e, name: nameFromEmail(e), createdAt: new Date(), updatedAt: new Date() },
    });
    // Create session row
    const token = uuid();
    const expDate = new Date(addDays(now(), SESSION_TTL_DAYS));
    await prisma.extranetSession.create({
        data: {
            partnerId: partner.id,
            token,
            expiresAt: expDate,
            createdAt: new Date(),
        },
    });
    return {
        token,
        expiresAt: expDate.getTime(),
        session: {
            email: e,
            name: partner.name ?? nameFromEmail(e),
            partnerId: partner.id,
            expiresAt: expDate.getTime(),
        },
    };
}
// Fetch a DB session by token
export async function getSession(token) {
    const t = (token || "").trim();
    if (!t)
        return null;
    const s = await prisma.extranetSession.findUnique({
        where: { token: t },
        include: { partner: true },
    });
    if (!s)
        return null;
    if (s.expiresAt.getTime() < now()) {
        try {
            await prisma.extranetSession.delete({ where: { token: t } });
        }
        catch { }
        return null;
    }
    return {
        email: s.partner?.email || "",
        name: s.partner?.name || nameFromEmail(s.partner?.email || ""),
        partnerId: s.partnerId,
        expiresAt: s.expiresAt.getTime(),
    };
}
export async function deleteSession(token) {
    const t = (token || "").trim();
    if (!t)
        return;
    try {
        await prisma.extranetSession.delete({ where: { token: t } });
    }
    catch { }
}
// ----- Property profile (in-memory scratch; API already persists real data) --
export function getProperty(email) {
    const e = email.trim().toLowerCase();
    if (!properties.has(e)) {
        properties.set(e, {
            name: null, contactEmail: null, phone: null,
            country: null, addressLine: null, city: null, description: null
        });
    }
    return properties.get(e);
}
export function saveProperty(email, data) {
    const cur = getProperty(email);
    const next = { ...cur, ...data };
    properties.set(email.trim().toLowerCase(), next);
    return next;
}
// ----- Auth helper for routes -----------------------------------------------
export async function authPartnerFromHeader(req, res, next) {
    try {
        const hdr = req.headers["authorization"] || "";
        const bearer = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
        const token = req.headers["x-partner-token"] || bearer || "";
        const s = await getSession(token);
        if (!s)
            return res.status(401).json({ error: "Unauthorized" });
        req.partner = { id: s.partnerId, email: s.email, name: s.name };
        req.partnerToken = token;
        return next();
    }
    catch {
        return res.status(401).json({ error: "Unauthorized" });
    }
}
