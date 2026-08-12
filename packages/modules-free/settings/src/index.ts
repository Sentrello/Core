import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import { defineModule } from "@sentrello/module-sdk";
import { eq } from "drizzle-orm";

/**
 * What this instance is, and what it is wired up to.
 *
 * The questions a business owner cannot otherwise answer without an SSH
 * session: is my licence current, can I take card payments yet, where do I
 * point Stripe, does email work. All of that lived only in environment
 * variables, which is fine for the person who installed it and useless for
 * the person running the business a year later.
 *
 * Reports whether a secret is *set*, never what it is. A settings page that
 * echoes an API key is a settings page that leaks one over a shoulder, into a
 * screenshot, or through a support request.
 */
function configured(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

export default defineModule({
  id: "settings",
  tier: "free",
  register(ctx) {
    ctx.registerNav({ id: "settings", label: "Settings", order: 90 });
    for (const p of ["read", "update"]) {
      ctx.registerPermission(`settings:${p}`);
    }

    ctx.app.get(
      "/api/settings",
      requireSession(),
      requirePermission({ settings: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const [org] = await db
          .select()
          .from(schema.organizations)
          .where(eq(schema.organizations.id, orgId))
          .limit(1);

        const base =
          process.env.SENTRELLO_BASE_URL ?? new URL(c.req.url).origin;

        return c.json({
          business: { name: org?.name ?? "", slug: org?.slug ?? "" },
          instance: {
            baseUrl: base,
            // Whether the address the instance thinks it has matches the one
            // being used. A mismatch is why payment links and portal links
            // arrive pointing at localhost.
            baseUrlMatchesRequest: base === new URL(c.req.url).origin,
          },
          email: {
            configured: configured("RESEND_API_KEY"),
            from: process.env.EMAIL_FROM ?? null,
          },
          payments: {
            stripe: {
              configured: configured("STRIPE_SECRET_KEY"),
              webhookConfigured: configured("STRIPE_WEBHOOK_SECRET"),
              testMode: (process.env.STRIPE_SECRET_KEY ?? "").startsWith(
                "sk_test_",
              ),
              invoiceWebhookUrl: `${base}/api/webhooks/stripe/invoices`,
              shopWebhookUrl: `${base}/api/shop/webhook/stripe`,
            },
            paypal: {
              configured:
                configured("PAYPAL_CLIENT_ID") &&
                configured("PAYPAL_CLIENT_SECRET"),
              webhookConfigured: configured("PAYPAL_WEBHOOK_ID"),
              environment: process.env.PAYPAL_ENV ?? "sandbox",
              shopWebhookUrl: `${base}/api/shop/webhook/paypal`,
            },
          },
        });
      },
    );

    /** Renaming the business. It appears on every page a customer sees. */
    ctx.app.put(
      "/api/settings",
      requireSession(),
      requirePermission({ settings: ["update"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const body = await c.req.json().catch(() => ({}));

        const name = String(body.name ?? "").trim();
        if (!name) return c.json({ error: "a name is required" }, 400);
        if (name.length > 120) {
          return c.json({ error: "that name is too long" }, 400);
        }

        const [org] = await db
          .update(schema.organizations)
          .set({ name })
          .where(eq(schema.organizations.id, orgId))
          .returning();
        return c.json({ business: { name: org?.name, slug: org?.slug } });
      },
    );
  },
});
