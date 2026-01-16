import { Router, type Request, type Response } from "express";
import bcrypt from "bcrypt";
import { prisma } from "../prisma.js";
import {
  issueCode,
  verifyCodeIssueSession,
  getSession,
  deleteSession,
  authPartnerFromHeader,
  getProperty,
  saveProperty,
} from "../session.js";

const router = Router();
const CODE_TTL_MIN = 10;

function normEmail(v: any): string {
  return String(v || "").trim().toLowerCase();
}

// Generic response to avoid leaking whether email or password was wrong
function invalidCreds(res: Response) {
  return res.status(400).json({ ok: false, error: "invalid_credentials" });
}

// ----- OTP: request code (NOW gated by email+password) -----------------------
router.post("/login/request-code", async (req: Request, res: Response) => {
  const email = normEmail(req.body?.email);
  const password = String(req.body?.password || "");

  if (!email || !email.includes("@")) return invalidCreds(res);
  if (!password) return invalidCreds(res);

  // Partner must exist and must have passwordHash set
  const partner = await prisma.extranet_Partner.findUnique({ where: { email } }).catch(() => null);
  if (!partner || !partner.passwordHash) return invalidCreds(res);

  // Validate password
  const ok = await bcrypt.compare(password, partner.passwordHash).catch(() => false);
  if (!ok) return invalidCreds(res);

  // Issue OTP only after password passes
  const { code, ttlMin } = issueCode(email);

  const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN || "";
  const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@lolaelo.com";

  if (POSTMARK_TOKEN) {
    const r = await (globalThis as any).fetch("https://api.postmarkapp.com/email", {
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

  // dev mode: return code in response
  return res.json({ ok: true, emailed: false, devCode: code, ttlMin });
});

// ----- OTP: verify code -> session ------------------------------------------
router.post("/login/verify-code", async (req: Request, res: Response) => {
  const email = normEmail(req.body?.email);
  const code = String(req.body?.code || "").trim();

  if (!email || !email.includes("@")) {
    return res.status(400).json({ ok: false, error: "invalid_email" });
  }
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ ok: false, error: "invalid_code_format" });
  }

  const out = await verifyCodeIssueSession(email, code);
  if (!out) return res.status(400).json({ ok: false, error: "invalid_or_expired_code" });

  return res.json({ ok: true, token: out.token, expiresAt: out.expiresAt });
});

// ----- Session info / logout -------------------------------------------------
router.get("/extranet/session", authPartnerFromHeader, async (req: any, res: Response) => {
  const token = req.partnerToken as string;
  const s = await getSession(token);
  if (!s) return res.status(401).json({ error: "Unauthorized" });

  return res.json({
    email: s.email,
    name: s.name,
    partnerId: s.partnerId,
    expiresAt: s.expiresAt,
  });
});

router.post("/extranet/logout", authPartnerFromHeader, async (req: any, res: Response) => {
  try {
    await deleteSession(req.partnerToken as string);
  } catch {}
  return res.json({ ok: true });
});

// ----- Property profile (use email from middleware) --------------------------
router.get("/extranet/property", authPartnerFromHeader, async (req: any, res: Response) => {
  const email = req.partner?.email as string | undefined;
  if (!email) return res.status(401).json({ error: "Unauthorized" });

  return res.json(getProperty(email));
});

router.put("/extranet/property", authPartnerFromHeader, async (req: any, res: Response) => {
  const email = req.partner?.email as string | undefined;
  if (!email) return res.status(401).json({ error: "Unauthorized" });

  const updated = saveProperty(email, req.body || {});
  return res.json(updated);
});

// ----- Legacy aliases --------------------------------------------------------
router.post("/extranet/login/request-code", (req, res) => res.redirect(307, "/login/request-code"));
router.post("/extranet/login", (req, res) => res.redirect(307, "/login/verify-code"));
router.post("/extranet/login/verify", (req, res) => res.redirect(307, "/login/verify-code"));

export default router;
