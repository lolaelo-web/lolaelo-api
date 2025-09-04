// src/mailer.ts
// Sends OTP emails via Postmark using Node 18+ fetch.
const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@lolaelo.com";
const FROM_NAME = process.env.FROM_NAME || "Team Lolaelo";
const REPLY_TO_EMAIL = process.env.REPLY_TO_EMAIL || ""; // optional but recommended
const MESSAGE_STREAM = process.env.POSTMARK_STREAM || "outbound";
const APP_LOGIN_URL = process.env.APP_LOGIN_URL || "https://lolaelo.com/partners_login.html";
const doFetch = global.fetch;
async function sendEmail(opts) {
    if (!POSTMARK_TOKEN) {
        console.log("[mailer] POSTMARK_TOKEN missing; skipping send", { to: opts.to, subject: opts.subject });
        return { skipped: true };
    }
    const payload = {
        From: `${FROM_NAME} <${FROM_EMAIL}>`,
        To: opts.to,
        Subject: opts.subject,
        TextBody: opts.text,
        HtmlBody: opts.html,
        MessageStream: MESSAGE_STREAM,
        Tag: opts.tag || "extranet-otp",
    };
    if (REPLY_TO_EMAIL)
        payload.ReplyTo = REPLY_TO_EMAIL;
    const res = await doFetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
            "X-Postmark-Server-Token": POSTMARK_TOKEN,
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        body: JSON.stringify(payload),
    });
    if (!res.ok) {
        const details = await res.text().catch(() => "");
        console.warn("[mailer] Postmark send failed", res.status, details);
        return { ok: false, status: res.status };
    }
    return { ok: true };
}
export async function sendLoginCodeEmail(to, code) {
    const subject = `Your Lolaelo sign-in code: ${code}`;
    const text = [
        `Your 6-digit code is ${code}.`,
        `It expires in 10 minutes.`,
        `Open the Extranet: ${APP_LOGIN_URL}`,
    ].join("\n");
    const html = `<!doctype html>
<html>
  <body style="margin:0;background:#f6f7fb;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7fb;padding:24px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;border:1px solid #e8ebf3;">
            <tr>
              <td style="padding:22px 24px 10px 24px;">
                <div style="font-size:18px;font-weight:600;color:#0b1320;">Lolaelo Extranet</div>
                <div style="font-size:14px;color:#56627a;margin-top:6px;">Your 6-digit sign-in code</div>
              </td>
            </tr>
            <tr>
              <td style="padding:6px 24px 12px 24px;">
                <div style="text-align:center;margin:10px 0 6px 0;">
                  <div style="display:inline-block;font-size:28px;letter-spacing:6px;font-weight:700;color:#0b1320;background:#f3f6ff;border:1px solid #e2e8ff;border-radius:10px;padding:14px 18px;">
                    ${code}
                  </div>
                </div>
                <div style="text-align:center;font-size:13px;color:#56627a;">Code expires in <b>10 minutes</b>.</div>
                <div style="text-align:center;margin:18px 0 8px 0;">
                  <a href="${APP_LOGIN_URL}" style="display:inline-block;background:#ff6a3d;color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:600;">Open Extranet</a>
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 20px 24px;color:#7a869a;font-size:12px;line-height:18px;">
                If you didn’t request this code, you can ignore this email.
              </td>
            </tr>
          </table>
          <div style="color:#9aa3b2;font-size:12px;margin-top:10px;">© ${new Date().getFullYear()} Lolaelo</div>
        </td>
      </tr>
    </table>
  </body>
</html>`;
    return sendEmail({ to, subject, text, html });
}
