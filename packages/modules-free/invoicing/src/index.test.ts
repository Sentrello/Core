import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import invoicing from "./index";

const suffix = crypto.randomUUID().slice(0, 8);
const email = `invoicing-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;
let contactId: string;

beforeAll(async () => {
  invoicing.register({
    app,
    entitled: () => true,
    registerNav: () => {},
    registerPermission: () => {},
    registerJob: () => {},
  });

  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Invoicing ${suffix}`, slug: `invoicing-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Acme Ltd", email: "ap@acme.test" })
    .returning();
  if (!contact) throw new Error("could not create test contact");
  contactId = contact.id;
});

afterAll(async () => {
  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  const entryIds = entries.map((e) => e.id);
  if (entryIds.length > 0) {
    await db
      .delete(schema.journalLines)
      .where(inArray(schema.journalLines.entryId, entryIds));
  }
  const invoices = await db
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));
  const invoiceIds = invoices.map((i) => i.id);
  if (invoiceIds.length > 0) {
    await db
      .delete(schema.invoiceLines)
      .where(inArray(schema.invoiceLines.invoiceId, invoiceIds));
  }
  for (const [table, column] of [
    [schema.journalEntries, schema.journalEntries.organizationId],
    [schema.payments, schema.payments.organizationId],
    [schema.invoices, schema.invoices.organizationId],
    [schema.accounts, schema.accounts.organizationId],
    [schema.contacts, schema.contacts.organizationId],
    [schema.documentCounters, schema.documentCounters.organizationId],
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

async function createInvoice(lines: unknown[], dueDate?: string) {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({ contactId, currency: "USD", dueDate, lines }),
  });
  return {
    res,
    body: (await res.json()) as {
      invoice: typeof schema.invoices.$inferSelect;
    },
  };
}

test("creating an invoice stores subtotal, tax and total in integer cents", async () => {
  const { res, body } = await createInvoice([
    { description: "Consulting", quantity: 2, unitPrice: 5000, taxRateBp: 875 },
    { description: "Hosting", quantity: 1, unitPrice: 2500, taxRateBp: 0 },
  ]);
  expect(res.status).toBe(201);
  expect(body.invoice.subtotalCents).toBe(12500);
  expect(body.invoice.taxCents).toBe(875);
  expect(body.invoice.totalCents).toBe(13375);
  expect(body.invoice.status).toBe("open");
  expect(body.invoice.number).toMatch(/^INV-\d{4}$/);
  expect(body.invoice.organizationId).toBe(orgId);
});

test("invoice numbers are sequential per organization", async () => {
  const first = await createInvoice([
    { description: "A", quantity: 1, unitPrice: 100, taxRateBp: 0 },
  ]);
  const second = await createInvoice([
    { description: "B", quantity: 1, unitPrice: 100, taxRateBp: 0 },
  ]);
  const n = (s: string) => Number(s.split("-")[1]);
  expect(n(second.body.invoice.number)).toBe(n(first.body.invoice.number) + 1);
});

test("issuing an invoice posts a balanced ledger entry", async () => {
  const { body } = await createInvoice([
    { description: "Work", quantity: 1, unitPrice: 10000, taxRateBp: 1000 },
  ]);

  const [entry] = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.source, `invoice:${body.invoice.id}`));
  expect(entry).toBeDefined();
  if (!entry) return;

  const lines = await db
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, entry.id));
  const debits = lines.reduce((s, l) => s + l.debitCents, 0);
  const credits = lines.reduce((s, l) => s + l.creditCents, 0);
  expect(debits).toBe(11000);
  expect(credits).toBe(11000);
});

test("a partial payment sets status partial and posts Dr Cash / Cr AR", async () => {
  const { body } = await createInvoice([
    { description: "Retainer", quantity: 1, unitPrice: 10000, taxRateBp: 0 },
  ]);

  const res = await app.request(
    `http://localhost/api/invoices/${body.invoice.id}/payments`,
    { method: "POST", headers, body: JSON.stringify({ amountCents: 2500 }) },
  );
  expect(res.status).toBe(201);
  const paid = (await res.json()) as { status: string; balanceDue: number };
  expect(paid.status).toBe("partial");
  expect(paid.balanceDue).toBe(7500);

  const [stored] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, body.invoice.id));
  expect(stored?.status).toBe("partial");

  const [entry] = await db
    .select()
    .from(schema.journalEntries)
    .where(
      eq(schema.journalEntries.memo, `Payment for ${body.invoice.number}`),
    );
  expect(entry).toBeDefined();
  if (!entry) return;
  const lines = await db
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, entry.id));
  expect(lines.reduce((s, l) => s + l.debitCents, 0)).toBe(2500);
  expect(lines.reduce((s, l) => s + l.creditCents, 0)).toBe(2500);
});

test("paying the remainder marks the invoice paid", async () => {
  const { body } = await createInvoice([
    { description: "Deposit", quantity: 1, unitPrice: 4000, taxRateBp: 0 },
  ]);
  const pay = (amountCents: number) =>
    app.request(`http://localhost/api/invoices/${body.invoice.id}/payments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ amountCents }),
    });

  await pay(1000);
  const res = await pay(3000);
  const paid = (await res.json()) as { status: string; balanceDue: number };
  expect(paid.status).toBe("paid");
  expect(paid.balanceDue).toBe(0);
});

test("a non-integer or negative payment is rejected", async () => {
  const { body } = await createInvoice([
    { description: "X", quantity: 1, unitPrice: 1000, taxRateBp: 0 },
  ]);
  for (const amountCents of [12.5, 0, -100]) {
    const res = await app.request(
      `http://localhost/api/invoices/${body.invoice.id}/payments`,
      { method: "POST", headers, body: JSON.stringify({ amountCents }) },
    );
    expect(res.status).toBe(400);
  }
});

test("paying an invoice from another organization is a 404, not a leak", async () => {
  const [foreign] = await db
    .insert(schema.invoices)
    .values({
      organizationId: `other-org-${suffix}`,
      number: "INV-9999",
      status: "open",
      totalCents: 5000,
    })
    .returning();
  if (!foreign) throw new Error("could not create foreign invoice");

  const res = await app.request(
    `http://localhost/api/invoices/${foreign.id}/payments`,
    { method: "POST", headers, body: JSON.stringify({ amountCents: 100 }) },
  );
  expect(res.status).toBe(404);

  await db.delete(schema.invoices).where(eq(schema.invoices.id, foreign.id));
});

test("a customer's portal link shows their invoices and nobody else's", async () => {
  // The people being invoiced have no account: the link is the credential.
  const minted = await app.request(
    `http://localhost/api/contacts/${contactId}/portal-link`,
    { method: "POST", headers },
  );
  expect(minted.status).toBe(200);
  const { url } = (await minted.json()) as { url: string };
  const path = new URL(url).pathname;
  expect(path).toMatch(/^\/portal\/[\w-]{43}$/);

  const [other] = await db
    .insert(schema.contacts)
    .values({
      organizationId: orgId,
      name: "Somebody Else",
      email: `other-${suffix}@example.test`,
    })
    .returning();
  await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId: other?.id,
      currency: "USD",
      lines: [
        {
          description: "Not yours",
          quantity: 1,
          unitPrice: 99900,
          taxRateBp: 0,
        },
      ],
    }),
  });

  const page = await app.request(`http://localhost${path}`);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  const body = await page.text();
  expect(body).toContain("Acme Ltd");
  expect(body).not.toContain("Somebody Else");
  expect(body).not.toContain("$999.00");
});

test("a guessed portal link is a 404, and rotating revokes the old one", async () => {
  const first = await app.request(
    `http://localhost/api/contacts/${contactId}/portal-link`,
    { method: "POST", headers },
  );
  const oldPath = new URL(((await first.json()) as { url: string }).url)
    .pathname;

  const guess = await app.request(`http://localhost/portal/${"z".repeat(43)}`);
  expect(guess.status).toBe(404);
  expect((await app.request("http://localhost/portal/short")).status).toBe(404);

  const rotated = await app.request(
    `http://localhost/api/contacts/${contactId}/portal-link?rotate=1`,
    { method: "POST", headers },
  );
  const newPath = new URL(((await rotated.json()) as { url: string }).url)
    .pathname;

  expect(newPath).not.toBe(oldPath);
  expect((await app.request(`http://localhost${oldPath}`)).status).toBe(404);
  expect((await app.request(`http://localhost${newPath}`)).status).toBe(200);
});

test("minting a link for another organization's contact is a 404", async () => {
  const [foreign] = await db
    .insert(schema.contacts)
    .values({ organizationId: `org_other_${suffix}`, name: "Not yours" })
    .returning();

  const res = await app.request(
    `http://localhost/api/contacts/${foreign?.id}/portal-link`,
    { method: "POST", headers },
  );
  expect(res.status).toBe(404);
  await db
    .delete(schema.contacts)
    .where(eq(schema.contacts.id, foreign?.id ?? ""));
});

test("the invoice list only returns this organization's rows", async () => {
  const res = await app.request("http://localhost/api/invoices", { headers });
  const body = (await res.json()) as {
    invoices: { organizationId: string }[];
  };
  expect(body.invoices.length).toBeGreaterThan(0);
  expect(body.invoices.every((i) => i.organizationId === orgId)).toBe(true);
});
