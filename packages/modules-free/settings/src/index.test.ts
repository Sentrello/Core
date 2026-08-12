import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import { eq } from "drizzle-orm";
import settings from "./index";

const suffix = crypto.randomUUID().slice(0, 8);
const email = `settings-${suffix}@example.test`;
const app = registerForTest(settings);

let orgId: string;
let headers: Headers;

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Settings ${suffix}`, slug: `settings-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });
});

afterAll(async () => {
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (u) {
    await db.delete(schema.session).where(eq(schema.session.userId, u.id));
    await db.delete(schema.account).where(eq(schema.account.userId, u.id));
    await db.delete(schema.user).where(eq(schema.user.id, u.id));
  }
});

async function read(): Promise<unknown> {
  const res = await app.request("http://localhost/api/settings", { headers });
  return res.json();
}

test("it reports whether a secret is set, never the secret", async () => {
  // A settings page that echoes an API key leaks one over a shoulder, into a
  // screenshot, or through a support request.
  process.env.STRIPE_SECRET_KEY = "sk_test_abcdef123456";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_supersecret";
  process.env.RESEND_API_KEY = "re_secret_value";
  try {
    const body = (await read()) as Record<string, unknown>;
    const serialised = JSON.stringify(body);

    expect(serialised).not.toContain("sk_test_abcdef123456");
    expect(serialised).not.toContain("whsec_supersecret");
    expect(serialised).not.toContain("re_secret_value");

    const payments = body.payments as {
      stripe: {
        configured: boolean;
        webhookConfigured: boolean;
        testMode: boolean;
      };
    };
    expect(payments.stripe.configured).toBe(true);
    expect(payments.stripe.webhookConfigured).toBe(true);
    expect(payments.stripe.testMode).toBe(true);
  } finally {
    process.env.STRIPE_SECRET_KEY = "";
    process.env.STRIPE_WEBHOOK_SECRET = "";
    process.env.RESEND_API_KEY = "";
  }
});

test("a half-configured Stripe is reported as half-configured", async () => {
  // Keys without a webhook is the state that charges cards and records
  // nothing, so it must not read as "set up".
  process.env.STRIPE_SECRET_KEY = "sk_live_something";
  process.env.STRIPE_WEBHOOK_SECRET = "";
  try {
    const body = (await read()) as {
      payments: {
        stripe: {
          configured: boolean;
          webhookConfigured: boolean;
          testMode: boolean;
        };
      };
    };
    expect(body.payments.stripe.configured).toBe(true);
    expect(body.payments.stripe.webhookConfigured).toBe(false);
    expect(body.payments.stripe.testMode).toBe(false);
  } finally {
    process.env.STRIPE_SECRET_KEY = "";
  }
});

test("the webhook addresses are the ones a provider needs", async () => {
  const body = (await read()) as {
    payments: {
      stripe: { invoiceWebhookUrl: string; shopWebhookUrl: string };
      paypal: { shopWebhookUrl: string };
    };
  };
  expect(body.payments.stripe.invoiceWebhookUrl).toContain(
    "/api/webhooks/stripe/invoices",
  );
  expect(body.payments.stripe.shopWebhookUrl).toContain(
    "/api/shop/webhook/stripe",
  );
  expect(body.payments.paypal.shopWebhookUrl).toContain(
    "/api/shop/webhook/paypal",
  );
});

test("renaming the business sticks", async () => {
  const res = await app.request("http://localhost/api/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({ name: "Northfield Joinery" }),
  });
  expect(res.status).toBe(200);

  const [org] = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  expect(org?.name).toBe("Northfield Joinery");
});

test("an empty or absurd name is refused", async () => {
  for (const name of ["", "   ", "x".repeat(200)]) {
    const res = await app.request("http://localhost/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(400);
  }
});

test("settings are not readable without a session", async () => {
  const res = await app.request("http://localhost/api/settings");
  expect(res.status).toBe(401);
});
