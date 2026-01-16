// src/routes/sessionHttp.ts
import express from "express";
import bcrypt from "bcrypt";
import { prisma } from "../prisma.js";
import {
  issueCode,
  verifyCodeIssueSession,
  getSession,
  deleteSession,
} from "../session.js";

const router = express.Router();

function normEmail(v: any): string {
  return String(v || "").trim().toLowerCase();
}

// generic to avoid leaking which part was wrong
function invalidCreds(res: any) {
  return res.status(400).json({ ok: false, error: "invalid_credentials" });
}

// POST /login/request-code  -> issues OTP (DEV: returns code in response)
// NOW gated by email + password
router.post("/login/request-code", async (req, res) => {
  try {
    const email = normEmail(req.body?.email);
    const password = String(req.body?.password || "");

    if (!email || !email.includes("@")) return invalidCreds(res);
    if (!password) return invalidCreds(res);

    const partner = await prisma.extranet_Partner.findUnique({ where: { email } }).catch(() => null);
    if (!partner || !partner.passwordHash) return invalidCreds(res);

    const ok = await bcrypt.compare(password, partner.passwordHash).catch(() => false);
    if (!ok) return invalidCreds(res);

    const r = issueCode(email);
    return res.json({ ok: true, email: r.email, ttlMin: r.ttlMin, devCode: r.code });
  } catch (e: any) {
    console.error("[sessionHttp] request-code error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "internal" });
  }
});

// POST /login/verify  -> verifies OTP and creates ExtranetSession row
router.post("/login/verify", async (req, res) => {
  try {
    const email = normEmail(req.body?.email);
    const code  = String(req.body?.code || "").trim();

    if (!email || !code) {
      return res.status(400).json({ ok: false, error: "missing_email_or_code" });
    }
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ ok: false, error: "invalid_code_format" });
    }

    const result = await verifyCodeIssueSession(email, code);
    if (!result) {
      return res.status(400).json({ ok: false, error: "invalid_or_expired_code" });
    }

    return res.json({
      ok: true,
      token: result.token,
      expiresAt: result.expiresAt,
      session: result.session,
    });
  } catch (e: any) {
    console.error("[sessionHttp] verify error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "internal" });
  }
});

// GET /session -> read session from Authorization: Bearer <token>
router.get("/session", async (req, res) => {
  try {
    const hdr = String(req.headers?.authorization || "");
    const bearer = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
    const s = await getSession(bearer);
    if (!s) return res.status(401).json({ ok: false, error: "unauthorized" });
    return res.json(s);
  } catch (e: any) {
    console.error("[sessionHttp] session error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "internal" });
  }
});

// POST /logout -> revoke session by Authorization token
router.post("/logout", async (req, res) => {
  try {
    const hdr = String(req.headers?.authorization || "");
    const bearer = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
    await deleteSession(bearer);
    return res.json({ ok: true });
  } catch (e: any) {
    console.error("[sessionHttp] logout error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "internal" });
  }
});

export default router;
