// src/routes/sessionHttp.ts
import express from "express";
import {
  issueCode,
  verifyCodeIssueSession,
  getSession,
  deleteSession,
} from "../session.js";

const router = express.Router();

// POST /login/request-code  -> issues OTP (DEV: returns code in response)
router.post("/login/request-code", (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Invalid email" });
    }
    const r = issueCode(email);
    return res.json({ ok: true, email: r.email, ttlMin: r.ttlMin, devCode: r.code });
  } catch (e: any) {
    console.error("[sessionHttp] request-code error:", e?.message || e);
    return res.status(500).json({ error: "Internal" });
  }
});

// POST /login/verify  -> verifies OTP and creates ExtranetSession row
router.post("/login/verify", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const code  = String(req.body?.code || "").trim();
    if (!email || !code) {
      return res.status(400).json({ error: "Missing email or code" });
    }
    const result = await verifyCodeIssueSession(email, code);
    if (!result) {
      return res.status(400).json({ error: "Invalid or expired code" });
    }
    return res.json({
      ok: true,
      token: result.token,
      expiresAt: result.expiresAt,
      session: result.session,
    });
  } catch (e: any) {
    console.error("[sessionHttp] verify error:", e?.message || e);
    return res.status(500).json({ error: "Internal" });
  }
});

// GET /session -> read session from Authorization: Bearer <token>
router.get("/session", async (req, res) => {
  try {
    const hdr = String(req.headers?.authorization || "");
    const bearer = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
    const s = await getSession(bearer);
    if (!s) return res.status(401).json({ error: "Unauthorized" });
    return res.json(s);
  } catch (e: any) {
    console.error("[sessionHttp] session error:", e?.message || e);
    return res.status(500).json({ error: "Internal" });
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
    return res.status(500).json({ error: "Internal" });
  }
});

export default router;
