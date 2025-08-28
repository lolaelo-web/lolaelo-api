import { Router, Request, Response } from "express";
import crypto from "crypto";

const router = Router();

const CODE_TTL_MINUTES = 10;
const SESSION_TTL_DAYS = 30;

// In-memory stores (simple + fast). Swap to DB later if needed.
type CodeItem = { code: string; expiresAt: number };
type SessionItem = { email: string; expiresAt: number };

const codeStore = new Map<string, CodeItem>();       // key = email
const sessionStore = new Map<string, SessionItem>(); // key = token

// Helpers
const now = () => Date.now();
const addMinutes = (ms: number, minutes: number) => ms + minutes * 60_000;
const addDays = (ms: number, days: number) => ms + days * 86_400_000;
const makeCode = () => String(Math.floor(100000 + Math.random() * 900000));
const makeToken = () => crypto.randomUUID();

// -------- POST /login/request-code -----------------------------------------
/**
 * Body: { email }
 * Returns: { ok, emailed|devCode, ttlMin }
 */
router.post("/login/request-code", async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) return res.status(400).json({ ok: false, error: "invalid_email" });

    const code = makeCode();
    codeStore.set(email, { code, expiresAt: addMinutes(now(), CODE_TTL_MINUTES) });

    const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN || "";
    const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@lolaelo.com";

    if (POSTMARK_TOKEN) {
      // Use global fetch without DOM types
      const resp = await (globalThis as any).fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": POSTMARK_TOKEN,
        },
        body: JSON.stringify({
          From: FROM_EMAIL,
          To: email,
          Subject: "Your Lolaelo Extranet Code",
          TextBody: `Your one-time code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes.`,
          MessageStream: "outbound",
        }),
      });

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        console.warn("Postmark send failed", resp.status, txt);
        return res.json({ ok: true, emailed: false, devCode: code, ttlMin: CODE_TTL_MINUTES });
      }
      return res.json({ ok: true, emailed: true, ttlMin: CODE_TTL_MINUTES });
    } else {
      // No mailer configured (dev/local)
      return res.json({ ok: true, emailed: false, devCode: code, ttlMin: CODE_TTL_MINUTES });
    }
  } catch (e) {
    console.error("request-code error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// -------- POST /login/verify-code ------------------------------------------
/**
 * Body: { email, code }
 * Returns: { ok, token, expiresAt }
 */
router.post("/login/verify-code", async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const code = String(req.body?.code || "").trim();

    if (!email || !email.includes("@")) return res.status(400).json({ ok: false, error: "invalid_email" });
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: "invalid_code_format" });

    const item = codeStore.get(email);
    if (!item) return res.status(400).json({ ok: false, error: "code_not_requested" });
    if (item.expiresAt < now()) {
      codeStore.delete(email);
      return res.status(400).json({ ok: false, error: "code_expired" });
    }
    if (item.code !== code) return res.status(400).json({ ok: false, error: "code_mismatch" });

    // Success → mint session
    codeStore.delete(email);
    const token = makeToken();
    const expiresAt = addDays(now(), SESSION_TTL_DAYS);
    sessionStore.set(token, { email, expiresAt });

    return res.json({ ok: true, token, expiresAt });
  } catch (e) {
    console.error("verify-code error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// -------- Legacy aliases (keep old FE calls working) -----------------------
router.post("/extranet/login/request-code", (req, res) => res.redirect(307, "/login/request-code"));
router.post("/extranet/login", (req, res) => res.redirect(307, "/login/verify-code"));

export default router;
