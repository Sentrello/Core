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

test("sending the link needs somewhere to send it", async () => {
  const [noEmail] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "No address" })
    .returning();

  const res = await app.request(
    `http://localhost/api/contacts/${noEmail?.id}/portal-link?send=1`,
    { method: "POST", headers },
  );
  expect(res.status).toBe(400);

  // the link still exists — the business can copy it by hand
  const copied = await app.request(
    `http://localhost/api/contacts/${noEmail?.id}/portal-link`,
    { method: "POST", headers },
  );
  expect(copied.status).toBe(200);
  await db
    .delete(schema.contacts)
    .where(eq(schema.contacts.id, noEmail?.id ?? ""));
});

/** A quote the business has sent, ready for an answer. */
async function sentQuote(forContactId: string, totalCents = 45000) {
  const res = await app.request("http://localhost/api/quotes", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId: forContactId,
      currency: "USD",
      lines: [
        {
          description: "Fitted shelving",
          quantity: 1,
          unitPrice: totalCents,
          taxRateBp: 0,
        },
      ],
    }),
  });
  const { quote } = (await res.json()) as { quote: { id: string } };
  await db
    .update(schema.quotes)
    .set({ status: "sent" })
    .where(eq(schema.quotes.id, quote.id));
  return quote.id;
}

const ledgerFor = async (source: string) => {
  const [entry] = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.source, source));
  if (!entry) return [];
  return db
    .select({
      debitCents: schema.journalLines.debitCents,
      creditCents: schema.journalLines.creditCents,
    })
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, entry.id));
};

test("one invoice comes back with its lines, payments and true balance", async () => {
  const created = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      lines: [
        {
          description: "Fitting",
          quantity: 2,
          unitPrice: 5000,
          taxRateBp: 875,
        },
        {
          description: "Materials",
          quantity: 1,
          unitPrice: 2500,
          taxRateBp: 0,
        },
      ],
    }),
  });
  const { invoice } = (await created.json()) as { invoice: { id: string } };

  await app.request(`http://localhost/api/invoices/${invoice.id}/payments`, {
    method: "POST",
    headers,
    body: JSON.stringify({ amountCents: 5000, method: "bank" }),
  });

  const res = await app.request(`http://localhost/api/invoices/${invoice.id}`, {
    headers,
  });
  expect(res.status).toBe(200);
  const detail = (await res.json()) as {
    lines: unknown[];
    payments: unknown[];
    paidCents: number;
    balanceDue: number;
    computedStatus: string;
    invoice: { totalCents: number };
  };

  expect(detail.lines).toHaveLength(2);
  expect(detail.payments).toHaveLength(1);
  expect(detail.paidCents).toBe(5000);
  // 2×50.00 at 8.75% = 108.75, plus 25.00 = 133.75, less 50.00 paid
  expect(detail.invoice.totalCents).toBe(13375);
  expect(detail.balanceDue).toBe(8375);
  expect(detail.computedStatus).toBe("partial");
});

test("another organization's invoice is a 404, not a detail page", async () => {
  const [foreign] = await db
    .insert(schema.invoices)
    .values({
      organizationId: `org_other_${suffix}`,
      number: `INV-PRIVATE-${suffix}`,
      status: "open",
      currency: "USD",
      subtotalCents: 5000,
      taxCents: 0,
      totalCents: 5000,
    })
    .returning();

  const res = await app.request(
    `http://localhost/api/invoices/${foreign?.id}`,
    {
      headers,
    },
  );
  expect(res.status).toBe(404);
  await db
    .delete(schema.invoices)
    .where(eq(schema.invoices.id, foreign?.id ?? ""));
});

test("sending an invoice records it on the timeline and links the portal", async () => {
  // The template existed and nothing called it: a business could raise an
  // invoice and had no way to deliver it.
  const created = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      lines: [
        {
          description: "Sent work",
          quantity: 1,
          unitPrice: 15000,
          taxRateBp: 0,
        },
      ],
    }),
  });
  const { invoice } = (await created.json()) as {
    invoice: { id: string; number: string };
  };

  const res = await app.request(
    `http://localhost/api/invoices/${invoice.id}/send`,
    { method: "POST", headers },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { sent: boolean; to: string };
  expect(body.sent).toBe(true);

  // sending mints the customer's portal token if they had none
  const [contact] = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, contactId));
  expect(contact?.portalToken).toBeTruthy();

  const timeline = await db
    .select()
    .from(schema.activities)
    .where(eq(schema.activities.contactId, contactId));
  expect(
    timeline.some((a) => a.body?.includes(`Sent invoice ${invoice.number}`)),
  ).toBe(true);
});

test("an invoice with no customer, or a customer with no address, cannot be sent", async () => {
  const [orphan] = await db
    .insert(schema.invoices)
    .values({
      organizationId: orgId,
      number: `INV-ORPHAN-${suffix}`,
      status: "open",
      currency: "USD",
      subtotalCents: 1000,
      taxCents: 0,
      totalCents: 1000,
    })
    .returning();
  expect(
    (
      await app.request(`http://localhost/api/invoices/${orphan?.id}/send`, {
        method: "POST",
        headers,
      })
    ).status,
  ).toBe(400);

  const [silent] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "No address" })
    .returning();
  const [theirs] = await db
    .insert(schema.invoices)
    .values({
      organizationId: orgId,
      contactId: silent?.id,
      number: `INV-SILENT-${suffix}`,
      status: "open",
      currency: "USD",
      subtotalCents: 1000,
      taxCents: 0,
      totalCents: 1000,
    })
    .returning();
  expect(
    (
      await app.request(`http://localhost/api/invoices/${theirs?.id}/send`, {
        method: "POST",
        headers,
      })
    ).status,
  ).toBe(400);
});

test("sending another organization's invoice is a 404", async () => {
  const [foreign] = await db
    .insert(schema.invoices)
    .values({
      organizationId: `org_other_${suffix}`,
      number: `INV-FOREIGN-${suffix}`,
      status: "open",
      currency: "USD",
      subtotalCents: 1000,
      taxCents: 0,
      totalCents: 1000,
    })
    .returning();

  const res = await app.request(
    `http://localhost/api/invoices/${foreign?.id}/send`,
    { method: "POST", headers },
  );
  expect(res.status).toBe(404);
  await db
    .delete(schema.invoices)
    .where(eq(schema.invoices.id, foreign?.id ?? ""));
});

test("sending a quote marks it sent, which is what the customer can see", async () => {
  const quoteId = await sentQuote(contactId, 33000);
  // sentQuote sets the status directly; here we exercise the real path
  await db
    .update(schema.quotes)
    .set({ status: "draft" })
    .where(eq(schema.quotes.id, quoteId));

  const res = await app.request(`http://localhost/api/quotes/${quoteId}/send`, {
    method: "POST",
    headers,
  });
  expect(res.status).toBe(200);

  const [quote] = await db
    .select()
    .from(schema.quotes)
    .where(eq(schema.quotes.id, quoteId));
  expect(quote?.status).toBe("sent");

  const timeline = await db
    .select()
    .from(schema.activities)
    .where(eq(schema.activities.contactId, contactId));
  expect(
    timeline.some((a) => a.body?.includes(`Sent quote ${quote?.number}`)),
  ).toBe(true);
});

test("a quote with no customer cannot be sent", async () => {
  const created = await app.request("http://localhost/api/quotes", {
    method: "POST",
    headers,
    body: JSON.stringify({
      currency: "USD",
      lines: [
        {
          description: "Nobody's work",
          quantity: 1,
          unitPrice: 100,
          taxRateBp: 0,
        },
      ],
    }),
  });
  const { quote } = (await created.json()) as { quote: { id: string } };

  const res = await app.request(
    `http://localhost/api/quotes/${quote.id}/send`,
    {
      method: "POST",
      headers,
    },
  );
  expect(res.status).toBe(400);
});

test("the quote list is this organization's only", async () => {
  const res = await app.request("http://localhost/api/quotes", { headers });
  const { quotes } = (await res.json()) as {
    quotes: { organizationId: string }[];
  };
  expect(quotes.length).toBeGreaterThan(0);
  expect(quotes.every((q) => q.organizationId === orgId)).toBe(true);
});

test("a customer accepting a quote raises an invoice that reaches the books", async () => {
  // Converting a quote used to create the invoice and post nothing, so the
  // revenue existed on the document and nowhere in the accounts.
  const quoteId = await sentQuote(contactId);
  const minted = await app.request(
    `http://localhost/api/contacts/${contactId}/portal-link`,
    { method: "POST", headers },
  );
  const token = new URL(((await minted.json()) as { url: string }).url).pathname
    .split("/")
    .pop() as string;

  const res = await app.request(
    `http://localhost/portal/${token}/quotes/${quoteId}/accept`,
    { method: "POST" },
  );
  expect(res.status).toBe(303);

  const [quote] = await db
    .select()
    .from(schema.quotes)
    .where(eq(schema.quotes.id, quoteId));
  expect(quote?.status).toBe("accepted");

  const [invoice] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.quoteId, quoteId));
  expect(invoice?.totalCents).toBe(45000);
  // An invoice with no due date can never be late, so it never appears on the
  // list of who owes you.
  expect(invoice?.dueDate).not.toBeNull();
  expect(invoice?.dueDate?.getTime()).toBeGreaterThan(Date.now());

  const lines = await ledgerFor(`invoice:${invoice?.id}`);
  expect(lines.length).toBeGreaterThan(0);
  const debits = lines.reduce((sum, l) => sum + l.debitCents, 0);
  const credits = lines.reduce((sum, l) => sum + l.creditCents, 0);
  expect(debits).toBe(credits);
  expect(debits).toBe(45000);
});

test("a quote cannot be accepted twice", async () => {
  // Twice would mean two invoices for one piece of work.
  const quoteId = await sentQuote(contactId, 12000);
  const minted = await app.request(
    `http://localhost/api/contacts/${contactId}/portal-link`,
    { method: "POST", headers },
  );
  const token = new URL(((await minted.json()) as { url: string }).url).pathname
    .split("/")
    .pop() as string;

  const first = await app.request(
    `http://localhost/portal/${token}/quotes/${quoteId}/accept`,
    { method: "POST" },
  );
  expect(first.status).toBe(303);

  const again = await app.request(
    `http://localhost/portal/${token}/quotes/${quoteId}/accept`,
    { method: "POST" },
  );
  expect(again.status).toBe(404);

  const invoices = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.quoteId, quoteId));
  expect(invoices).toHaveLength(1);
});

test("a customer cannot accept somebody else's quote", async () => {
  const [other] = await db
    .insert(schema.contacts)
    .values({
      organizationId: orgId,
      name: "Another customer",
      email: `another-${suffix}@example.test`,
    })
    .returning();
  const theirQuote = await sentQuote(other?.id ?? "", 88800);

  const minted = await app.request(
    `http://localhost/api/contacts/${contactId}/portal-link`,
    { method: "POST", headers },
  );
  const token = new URL(((await minted.json()) as { url: string }).url).pathname
    .split("/")
    .pop() as string;

  const res = await app.request(
    `http://localhost/portal/${token}/quotes/${theirQuote}/accept`,
    { method: "POST" },
  );
  expect(res.status).toBe(404);

  const invoices = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.quoteId, theirQuote));
  expect(invoices).toHaveLength(0);
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

/**
 * The shape a client gets wrong most often is the field names on a line.
 *
 * Sending unitPriceCents instead of unitPrice used to multiply out to NaN,
 * reach Postgres, and come back as a bare 500 with a stack trace in the logs —
 * no indication of which field was wrong.
 */
test("a malformed invoice line is a 400 that names the problem", async () => {
  const res = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      lines: [
        {
          description: "Consumer unit replacement",
          quantity: 1,
          unitPriceCents: 48500,
          taxRateBasisPoints: 875,
        },
      ],
    }),
  });

  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("unitPrice");
  expect(body.error).toContain("line 1");
});

test("a malformed quote line is refused the same way", async () => {
  const res = await app.request("http://localhost/api/quotes", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      lines: [{ description: "Survey", quantity: 1, unitPrice: "500" }],
    }),
  });
  expect(res.status).toBe(400);
});

test("a rejected invoice leaves nothing behind", async () => {
  const before = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));

  await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      lines: [{ description: "Bad", quantity: 1, unitPriceCents: 100 }],
    }),
  });

  const after = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));
  expect(after).toHaveLength(before.length);
});
