// src/mailer.ts
// Sends OTP emails via Postmark. No extra deps required (uses Node 18+ global fetch).

const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "no-reply@lolaelo.com";
const MESSAGE_STREAM = process.env.POSTMARK_STREAM || "outbound";

// Minimal fetch type to avoid TS DOM typings requirement
type AnyFetch = (input: any, init?: any) => Promise<any>;
const doFetch: AnyFetch = (global as any).fetch;

/** Low-level helper */
async function sendEmail(opts: { to: string; subject: string; text: string; html?: string }) {
  if (!POSTMARK_TOKEN) {
    console.log("[mailer] POSTMARK_TOKEN missing; skipping send", { to: opts.to, subject: opts.subject });
    return { skipped: true };
  }

  const res = await doFetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "X-Postmark-Server-Token": POSTMARK_TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      From: FROM_EMAIL,
      To: opts.to,
      Subject: opts.subject,
      TextBody: opts.text,
      HtmlBody: opts.html ?? `<pre>${opts.text}</pre>`,
      MessageStream: MESSAGE_STREAM,
    }),
  });

  if (!res.ok) {
    const details = await res.text().catch(() => "");
    console.warn("[mailer] Postmark send failed", res.status, details);
    return { ok: false, status: res.status };
  }
  return { ok: true };
}

/** High-level helper for the login code */
export async function sendLoginCodeEmail(to: string, code: string) {
  const subject = "Your Lolaelo Extranet sign-in code";
  const text = `Your 6-digit code is ${code}. It expires in 10 minutes.`;
  const html = `<p>Your 6-digit code is <b style="font-size:18px">${code}</b>.</p><p>It expires in 10 minutes.</p>`;
  return sendEmail({ to, subject, text, html });
}
