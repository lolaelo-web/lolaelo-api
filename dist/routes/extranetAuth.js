import { Router } from "express";
import { issueCode, verifyCodeIssueSession, getSession, deleteSession, authPartnerFromHeader, getProperty, saveProperty, } from "../session.js";
const router = Router();
const CODE_TTL_MIN = 10;
// ----- OTP: request code -----------------------------------------------------
router.post("/login/request-code", async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
        return res.status(400).json({ ok: false, error: "invalid_email" });
    }
    const { code, ttlMin } = issueCode(email);
    const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN || "";
    const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@lolaelo.com";
    if (POSTMARK_TOKEN) {
        const r = await globalThis.fetch("https://api.postmarkapp.com/email", {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "X-Postmark-Server-Token": POSTMARK_TOKEN,
            },
            body: JSON.stringify({
                From: FROM_EMAIL,
                To: email,
                Subject: "Your Lolaelo Extranet Code",
                TextBody: `Your one-time code is ${code}. It expires in ${CODE_TTL_MIN} minutes.`,
                MessageStream: "outbound",
            }),
        });
        if (!r.ok) {
            const txt = await r.text().catch(() => "");
            console.warn("Postmark send failed", r.status, txt);
            return res.json({ ok: true, emailed: false, devCode: code, ttlMin });
        }
        return res.json({ ok: true, emailed: true, ttlMin });
    }
    else {
        // dev mode: return code in response
        return res.json({ ok: true, emailed: false, devCode: code, ttlMin });
    }
});
// ----- OTP: verify code -> session ------------------------------------------
router.post("/login/verify-code", async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const code = String(req.body?.code || "").trim();
    if (!email || !email.includes("@")) {
        return res.status(400).json({ ok: false, error: "invalid_email" });
    }
    if (!/^\d{6}$/.test(code)) {
        return res.status(400).json({ ok: false, error: "invalid_code_format" });
    }
    const out = await verifyCodeIssueSession(email, code);
    if (!out)
        return res.status(400).json({ ok: false, error: "invalid_or_expired_code" });
    return res.json({ ok: true, token: out.token, expiresAt: out.expiresAt });
});
// ----- Session info / logout -------------------------------------------------
// Uses auth middleware; we only need expiresAt, so fetch the session once.
router.get("/extranet/session", authPartnerFromHeader, async (req, res) => {
    const token = req.partnerToken;
    const s = await getSession(token);
    if (!s)
        return res.status(401).json({ error: "Unauthorized" });
    return res.json({
        email: s.email,
        name: s.name,
        partnerId: s.partnerId,
        expiresAt: s.expiresAt,
    });
});
router.post("/extranet/logout", authPartnerFromHeader, async (req, res) => {
    try {
        await deleteSession(req.partnerToken);
    }
    catch { }
    return res.json({ ok: true });
});
// ----- Property profile (use email from middleware) --------------------------
router.get("/extranet/property", authPartnerFromHeader, async (req, res) => {
    // auth middleware already attached req.partner
    const email = req.partner?.email;
    if (!email)
        return res.status(401).json({ error: "Unauthorized" });
    return res.json(getProperty(email));
});
router.put("/extranet/property", authPartnerFromHeader, async (req, res) => {
    const email = req.partner?.email;
    if (!email)
        return res.status(401).json({ error: "Unauthorized" });
    const updated = saveProperty(email, req.body || {});
    return res.json(updated);
});
// ----- Legacy aliases --------------------------------------------------------
router.post("/extranet/login/request-code", (req, res) => res.redirect(307, "/login/request-code"));
router.post("/extranet/login", (req, res) => res.redirect(307, "/login/verify-code"));
export default router;
