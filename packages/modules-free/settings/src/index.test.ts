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

/**
 * The business identity that appears on every document a customer receives.
 *
 * A name alone is not a valid invoice in the UK or the EU, and a business paid
 * by transfer whose invoices omit its bank details answers "where do I send
 * this?" on every one. These are stored so the portal footer can carry them.
 */
test("the business can record its address, tax number and payment details", async () => {
  const res = await app.request("http://localhost/api/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      name: "Wierzbicki Tiling",
      address: "Unit 4, Tanners Yard\nLeeds LS9 8AB",
      taxIdLabel: "VAT number",
      taxId: "GB 412 7749 02",
      paymentInstructions: "Bank transfer to 20-45-11, account 8842 3901.",
    }),
  });
  expect(res.status).toBe(200);

  const read = await app.request("http://localhost/api/settings", { headers });
  const body = (await read.json()) as {
    business: {
      address: string;
      taxId: string;
      taxIdLabel: string;
      paymentInstructions: string;
    };
  };
  expect(body.business.address).toContain("Tanners Yard");
  expect(body.business.taxId).toBe("GB 412 7749 02");
  expect(body.business.taxIdLabel).toBe("VAT number");
  expect(body.business.paymentInstructions).toContain("20-45-11");
});

test("blanking a field clears it rather than storing an empty string", async () => {
  await app.request("http://localhost/api/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({ name: "Wierzbicki Tiling", address: "   " }),
  });
  const read = await app.request("http://localhost/api/settings", { headers });
  const body = (await read.json()) as { business: { address: string } };
  expect(body.business.address).toBe("");
});

test("an address longer than a document is refused", async () => {
  const res = await app.request("http://localhost/api/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      name: "Wierzbicki Tiling",
      address: "x".repeat(501),
    }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("address");
});

/**
 * Settings name the business and carry what appears on its invoices, so a
 * scoping slip here would show one business another's address and bank
 * details — and let it rename them.
 */
test("another organization's settings cannot be read or written", async () => {
  const theirs = `other-org-${crypto.randomUUID().slice(0, 8)}`;
  await db.insert(schema.organizations).values({
    id: theirs,
    name: "Their Secret Trading Name",
    slug: theirs,
    createdAt: new Date(),
    address: "Their Private Address",
  });

  const read = await app.request("http://localhost/api/settings", { headers });
  const body = await read.text();
  expect(body).not.toContain("Their Secret Trading Name");
  expect(body).not.toContain("Their Private Address");

  // Writing goes to the session's own organization, whatever is asked for.
  await app.request("http://localhost/api/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({ name: "Renamed", organizationId: theirs }),
  });
  const [untouched] = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.id, theirs));
  expect(untouched?.name).toBe("Their Secret Trading Name");

  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, theirs));
});

/**
 * The update button.
 *
 * The app cannot update itself — it lives in the container being replaced — so
 * these cover what it is allowed to do: report a version, and ask. The asking
 * is guarded harder than the reporting, because replacing the running version
 * is the most consequential button in the product.
 */
test("the update screen reports the running version", async () => {
  const res = await app.request("http://localhost/api/settings/updates", {
    headers,
  });
  expect(res.status).toBe(200);

  const body = (await res.json()) as {
    current: string;
    canApply: boolean;
    status: { state: string };
  };
  expect(body.current).toBeTruthy();
  // No agent in a test process, so the screen must not offer a dead button.
  expect(body.canApply).toBe(false);
  expect(body.status.state).toBe("idle");
});

test("an instance with no agent refuses rather than pretending", async () => {
  const res = await app.request("http://localhost/api/settings/updates", {
    method: "POST",
    headers,
    body: "{}",
  });
  // Either it could not reach the licence server, or there is no agent. Both
  // are honest refusals; what must never happen is a 202 that goes nowhere.
  expect([503, 409]).toContain(res.status);
  expect(res.status).not.toBe(202);
});

test("rollback refuses when there is nowhere to go back to", async () => {
  const res = await app.request("http://localhost/api/settings/rollback", {
    method: "POST",
    headers,
    body: "{}",
  });
  // No recorded previous version and no agent. Either refusal is honest; a 202
  // would be a promise to restart the business and then do nothing.
  expect(res.status).toBe(409);
  expect(res.status).not.toBe(202);
});
