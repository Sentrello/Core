import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import { defineModule } from "@sentrello/module-sdk";
import { eq } from "drizzle-orm";
import {
  agentPresent,
  currentVersion,
  isNewer,
  latestVersion,
  readStatus,
  requestRollback,
  requestUpdate,
  rollbackTarget,
} from "./updates";

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
          business: {
            name: org?.name ?? "",
            slug: org?.slug ?? "",
            address: org?.address ?? "",
            taxId: org?.taxId ?? "",
            taxIdLabel: org?.taxIdLabel ?? "",
            paymentInstructions: org?.paymentInstructions ?? "",
          },
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
    /**
     * What version this is, and whether there is a newer one.
     *
     * Behind the read permission rather than public: it names the release an
     * instance runs, which is the first thing anyone probing for a known
     * vulnerability wants to know.
     */
    ctx.app.get(
      "/api/settings/updates",
      requireSession(),
      requirePermission({ settings: ["read"] }),
      async (c) => {
        const current = currentVersion();
        const latest = await latestVersion();

        return c.json({
          current,
          latest,
          rollbackTo: await rollbackTarget(),
          updateAvailable: latest !== null && isNewer(latest, current),
          // Without an agent the button would write a file nobody reads, so
          // the screen needs to know to explain instead of offering.
          canApply: await agentPresent(),
          status: await readStatus(),
        });
      },
    );

    /**
     * Ask the host to put the previous release back.
     *
     * Guarded like the update it undoes. The version is not taken from the
     * request body: it is whatever the host recorded when it updated, so a
     * form cannot ask this instance to run some other release.
     */
    ctx.app.post(
      "/api/settings/rollback",
      requireSession(),
      requirePermission({ settings: ["update"] }),
      async (c) => {
        const target = await rollbackTarget();
        if (!target) {
          return c.json(
            { error: "there is no earlier version to go back to" },
            409,
          );
        }
        if (!(await agentPresent())) {
          return c.json(
            {
              error:
                "this instance has no update agent, so it cannot roll itself back. Run `sentrello rollback` on the server.",
            },
            409,
          );
        }

        await requestRollback(target);
        return c.json({ status: await readStatus() }, 202);
      },
    );

    /**
     * Ask the host to update.
     *
     * `settings: ["update"]` rather than read: replacing the running version
     * is the most consequential button in the product, and staff have the read
     * permission so they can see whether email works.
     */
    ctx.app.post(
      "/api/settings/updates",
      requireSession(),
      requirePermission({ settings: ["update"] }),
      async (c) => {
        const current = currentVersion();
        const latest = await latestVersion();

        if (!latest) {
          return c.json(
            {
              error: "could not reach the licence server to check for updates",
            },
            503,
          );
        }
        if (!isNewer(latest, current)) {
          // Not an error worth alarming anyone with, but not a no-op either:
          // saying so beats a spinner that resolves into nothing.
          return c.json({ error: `already running ${current}` }, 409);
        }
        if (!(await agentPresent())) {
          return c.json(
            {
              error:
                "this instance has no update agent, so it cannot update itself. Run `sentrello update` on the server.",
            },
            409,
          );
        }

        await requestUpdate(latest);
        return c.json({ status: await readStatus() }, 202);
      },
    );

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

        // These reach customers on every invoice, so they are bounded rather
        // than trusted: an address is a few lines, not a document.
        const text = (value: unknown, limit: number, field: string) => {
          const trimmed = String(value ?? "").trim();
          if (trimmed.length > limit) throw new RangeError(field);
          return trimmed || null;
        };

        let address: string | null;
        let taxId: string | null;
        let taxIdLabel: string | null;
        let paymentInstructions: string | null;
        try {
          address = text(body.address, 500, "address");
          taxId = text(body.taxId, 60, "tax number");
          taxIdLabel = text(body.taxIdLabel, 40, "tax number label");
          paymentInstructions = text(
            body.paymentInstructions,
            800,
            "payment instructions",
          );
        } catch (err) {
          if (err instanceof RangeError) {
            return c.json({ error: `that ${err.message} is too long` }, 400);
          }
          throw err;
        }

        const [org] = await db
          .update(schema.organizations)
          .set({ name, address, taxId, taxIdLabel, paymentInstructions })
          .where(eq(schema.organizations.id, orgId))
          .returning();
        return c.json({
          business: {
            name: org?.name,
            slug: org?.slug,
            address: org?.address ?? "",
            taxId: org?.taxId ?? "",
            taxIdLabel: org?.taxIdLabel ?? "",
            paymentInstructions: org?.paymentInstructions ?? "",
          },
        });
      },
    );
  },
});
