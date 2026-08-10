import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, inArray, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import { HONEYPOT_FIELD, resetRateLimits } from "./embed";
import forms from "./index";

const suffix = crypto.randomUUID().slice(0, 8);
const email = `forms-${suffix}@example.test`;
const app = registerForTest(forms);

let orgId: string;
let headers: Headers;
let contactFormKey: string;
let quoteFormKey: string;

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
    body: { name: `Forms ${suffix}`, slug: `forms-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  for (const [kind, target] of [
    ["contact", "contact"],
    ["quote", "quote"],
  ] as const) {
    const res = await app.request("http://localhost/api/forms", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: `${target} form`,
        kind,
        allowedOrigins: ["https://acme.com", "*.shop.acme.com"],
      }),
    });
    const { form } = (await res.json()) as { form: { key: string } };
    if (kind === "contact") contactFormKey = form.key;
    else quoteFormKey = form.key;
  }
});

afterAll(async () => {
  const formIds = (
    await db
      .select({ id: schema.forms.id })
      .from(schema.forms)
      .where(eq(schema.forms.organizationId, orgId))
  ).map((f) => f.id);
  if (formIds.length > 0) {
    await db
      .delete(schema.formSubmissions)
      .where(inArray(schema.formSubmissions.formId, formIds));
  }
  for (const [table, column] of [
    [schema.forms, schema.forms.organizationId],
    [schema.quoteLines, schema.quoteLines.quoteId], // cleaned via quotes below
  ] as const) {
    if (column === schema.quoteLines.quoteId) continue;
    await db.delete(table).where(eq(column, orgId));
  }
  const quoteIds = (
    await db
      .select({ id: schema.quotes.id })
      .from(schema.quotes)
      .where(eq(schema.quotes.organizationId, orgId))
  ).map((q) => q.id);
  if (quoteIds.length > 0) {
    await db
      .delete(schema.quoteLines)
      .where(inArray(schema.quoteLines.quoteId, quoteIds));
  }
  for (const [table, column] of [
    [schema.quotes, schema.quotes.organizationId],
    [schema.documentCounters, schema.documentCounters.organizationId],
    [schema.activities, schema.activities.organizationId],
    [schema.contacts, schema.contacts.organizationId],
  ] as const) {
    await db.delete(table).where(eq(column, orgId));
  }
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

function submit(key: string, body: unknown, origin = "https://acme.com") {
  resetRateLimits();
  return app.request(`http://localhost/api/embed/forms/${key}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

test("a submission from an allowed origin creates a lead and a timeline note", async () => {
  const res = await submit(contactFormKey, {
    name: "Dana Pike",
    email: "dana@buyer.example",
    phone: "555-0100",
    message: "Do you cover Boulder?",
  });
  expect(res.status).toBe(201);
  expect(res.headers.get("access-control-allow-origin")).toBe(
    "https://acme.com",
  );

  const [contact] = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.email, "dana@buyer.example"));
  expect(contact?.organizationId).toBe(orgId);
  expect(contact?.kind).toBe("lead");
  expect(contact?.phone).toBe("555-0100");

  const activities = await db
    .select()
    .from(schema.activities)
    .where(eq(schema.activities.contactId, contact?.id ?? ""));
  expect(activities[0]?.body).toContain("Boulder");
});

test("a second enquiry from the same address reuses the contact", async () => {
  await submit(contactFormKey, {
    name: "Dana Pike",
    email: "dana@buyer.example",
    message: "Following up",
  });
  const rows = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.email, "dana@buyer.example"));
  expect(rows).toHaveLength(1);
});

test("an unlisted origin gets a 404 that reveals nothing", async () => {
  const res = await submit(
    contactFormKey,
    { name: "Mallory", email: "m@evil.example" },
    "https://evil.example",
  );
  expect(res.status).toBe(404);
  expect(res.headers.get("access-control-allow-origin")).toBeNull();

  const rows = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.email, "m@evil.example"));
  expect(rows).toHaveLength(0);
});

test("an unknown form key is indistinguishable from a refused origin", async () => {
  const res = await submit("frm_does_not_exist", { name: "X" });
  expect(res.status).toBe(404);
});

test("a wildcard subdomain is accepted", async () => {
  const res = await submit(
    contactFormKey,
    { name: "Sub Domain", email: "sub@buyer.example" },
    "https://eu.shop.acme.com",
  );
  expect(res.status).toBe(201);
});

test("a filled honeypot is accepted silently and writes nothing", async () => {
  const res = await submit(contactFormKey, {
    name: "Spam Bot",
    email: "bot@spam.example",
    [HONEYPOT_FIELD]: "http://buy-pills.example",
  });
  // 202, not an error: telling a bot it was caught only teaches it to adapt
  expect(res.status).toBe(202);

  const rows = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.email, "bot@spam.example"));
  expect(rows).toHaveLength(0);
});

test("a submission with neither name nor email is rejected", async () => {
  const res = await submit(contactFormKey, { message: "..." });
  expect(res.status).toBe(400);
});

test("a burst from one client is rate limited", async () => {
  resetRateLimits();
  const send = () =>
    app.request(`http://localhost/api/embed/forms/${contactFormKey}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://acme.com",
        "x-real-ip": "9.9.9.9",
      },
      body: JSON.stringify({ name: "Flood", email: "flood@buyer.example" }),
    });

  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await send()).status);
  expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
});

test("a plain HTML form post works, so a snippet needs no JavaScript", async () => {
  resetRateLimits();
  const body = new URLSearchParams({
    name: "No Script",
    email: "noscript@buyer.example",
    message: "Sent as a normal form",
  });
  const res = await app.request(
    `http://localhost/api/embed/forms/${contactFormKey}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://acme.com",
      },
      body,
    },
  );
  expect(res.status).toBe(201);
});

test("a quote form drafts a quote for pricing", async () => {
  const res = await submit(quoteFormKey, {
    name: "Quote Seeker",
    email: "quote@buyer.example",
    message: "Fence repair, about 40 feet",
  });
  expect(res.status).toBe(201);

  const [quote] = await db
    .select()
    .from(schema.quotes)
    .where(eq(schema.quotes.organizationId, orgId));
  expect(quote?.status).toBe("draft");
  expect(quote?.number).toMatch(/^QUO-\d{4}$/);
  expect(quote?.totalCents).toBe(0); // nothing priced yet

  const lines = await db
    .select()
    .from(schema.quoteLines)
    .where(eq(schema.quoteLines.quoteId, quote?.id ?? ""));
  expect(lines[0]?.description).toContain("Fence repair");
});

test("the public definition endpoint exposes fields but no internals", async () => {
  const res = await app.request(
    `http://localhost/api/embed/forms/${contactFormKey}`,
    { headers: { origin: "https://acme.com" } },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.honeypot).toBe(HONEYPOT_FIELD);
  expect(Array.isArray(body.fields)).toBe(true);
  // never leak which instance or organization this belongs to
  expect(body.organizationId).toBeUndefined();
  expect(body.id).toBeUndefined();
});

test("preflight is answered for an allowed origin and refused otherwise", async () => {
  const ok = await app.request(
    `http://localhost/api/embed/forms/${contactFormKey}`,
    { method: "OPTIONS", headers: { origin: "https://acme.com" } },
  );
  expect(ok.status).toBe(204);
  expect(ok.headers.get("access-control-allow-origin")).toBe(
    "https://acme.com",
  );

  const denied = await app.request(
    `http://localhost/api/embed/forms/${contactFormKey}`,
    { method: "OPTIONS", headers: { origin: "https://evil.example" } },
  );
  expect(denied.status).toBe(403);
});

test("submissions are visible to the owner, scoped to their organization", async () => {
  const formId = (
    await db
      .select({ id: schema.forms.id })
      .from(schema.forms)
      .where(eq(schema.forms.key, contactFormKey))
  )[0]?.id;

  const res = await app.request(
    `http://localhost/api/forms/${formId}/submissions`,
    { headers },
  );
  const body = (await res.json()) as { submissions: unknown[] };
  expect(body.submissions.length).toBeGreaterThan(0);
});
