import nodemailer from "nodemailer";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  from?: string;
}

export interface EmailAdapter {
  send(msg: EmailMessage): Promise<void>;
}

class ResendAdapter implements EmailAdapter {
  constructor(
    private key: string,
    private from: string,
  ) {}

  async send(m: EmailMessage) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: m.from ?? this.from,
        to: m.to,
        subject: m.subject,
        html: m.html,
      }),
    });
    if (!res.ok) {
      throw new Error(`resend send failed: ${res.status} ${await res.text()}`);
    }
  }
}

class SmtpAdapter implements EmailAdapter {
  private transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });

  async send(m: EmailMessage) {
    await this.transport.sendMail({
      from: m.from ?? process.env.EMAIL_FROM,
      to: m.to,
      subject: m.subject,
      html: m.html,
    });
  }
}

/** No mail configured: log instead of throwing, so jobs never crash a boot. */
class NoopAdapter implements EmailAdapter {
  async send(m: EmailMessage) {
    console.warn(`[email] no adapter configured, dropping mail to ${m.to}`);
  }
}

/**
 * Whether this instance can actually send mail.
 *
 * A self-hosted instance may have no mail configured at all, and a password
 * reset that silently posts into a NoopAdapter would leave the only
 * administrator locked out with a screen telling them to check their inbox.
 * The sign-in page asks this so it can offer the truth instead.
 */
export function mailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY || process.env.SMTP_HOST);
}

export function emailAdapter(): EmailAdapter {
  if (process.env.RESEND_API_KEY) {
    return new ResendAdapter(
      process.env.RESEND_API_KEY,
      process.env.EMAIL_FROM ?? "sentrello@localhost",
    );
  }
  if (process.env.SMTP_HOST) return new SmtpAdapter();
  return new NoopAdapter();
}
