import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, eq, inArray, schema } from "@sentrello/db";
import { runRecurringInvoices } from "./recurring";

/**
 * The recurring job issues invoices nobody is watching.
 *
 * It runs unattended, creates money documents and posts to the ledger, and had
 * no tests at all. Two things it got wrong were only visible from outside: the
 * invoices carried no due date, so overdue chasing — which skips invoices
 * without one — never saw them; and one unusable template threw, taking every
 * other business's invoices for that day down with it.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgId = `rec-${suffix}`;
let contactId: string;

beforeAll(async () => {
  await db.insert(schema.organizations).values({
    id: orgId,
    name: `Recurring ${suffix}`,
    slug: `recurring-${suffix}`,
    createdAt: new Date(),
  });
  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Monthly Client", kind: "customer" })
    .returning();
  if (!contact) throw new Error("could not create the test contact");
  contactId = contact.id;
});

afterAll(async () => {
  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  const ids = entries.map((e) => e.id);
  if (ids.length > 0) {
    await db
      .delete(schema.journalLines)
      .where(inArray(schema.journalLines.entryId, ids));
  }
  for (const [table, column] of [
    [schema.journalEntries, schema.journalEntries.organizationId],
    [schema.invoiceLines, null],
    [schema.invoices, schema.invoices.organizationId],
    [schema.accounts, schema.accounts.organizationId],
    [schema.recurringProfiles, schema.recurringProfiles.organizationId],
    [schema.documentCounters, schema.documentCounters.organizationId],
    [schema.contacts, schema.contacts.organizationId],
  ] as const) {
    if (!column) continue;
    await db.delete(table).where(eq(column, orgId));
  }
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
});

const yesterday = () => new Date(Date.now() - 86_400_000);

test("a due profile issues an invoice that can actually be chased", async () => {
  await db.insert(schema.recurringProfiles).values({
    organizationId: orgId,
    contactId,
    interval: "monthly",
    nextRunAt: yesterday(),
    templateJson: {
      lines: [
        {
          description: "Maintenance retainer",
          quantity: 1,
          unitPrice: 45000,
          taxRateBp: 875,
        },
      ],
    },
  });

  const result = await runRecurringInvoices();
  expect(result.issued).toBeGreaterThanOrEqual(1);

  const [invoice] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));

  expect(invoice?.totalCents).toBe(48938); // 45000 + 8.75%, rounded
  // The whole point: overdue chasing filters on `dueDate is not null`.
  const dueDate = invoice?.dueDate;
  if (!dueDate) throw new Error("a recurring invoice must carry a due date");
  expect(dueDate.getTime()).toBeGreaterThan(Date.now());

  const lines = await db
    .select()
    .from(schema.journalLines)
    .innerJoin(
      schema.journalEntries,
      eq(schema.journalLines.entryId, schema.journalEntries.id),
    )
    .where(eq(schema.journalEntries.organizationId, orgId));
  const debits = lines.reduce((s, l) => s + l.journal_lines.debitCents, 0);
  const credits = lines.reduce((s, l) => s + l.journal_lines.creditCents, 0);
  expect(debits).toBe(48938);
  expect(credits).toBe(48938);
});

test("the schedule moves on, so the same invoice is not issued twice", async () => {
  const before = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));

  const again = await runRecurringInvoices();
  expect(again.issued).toBe(0);

  const after = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));
  expect(after).toHaveLength(before.length);
});

test("one unusable template does not stop the rest of the run", async () => {
  // A template whose field names are wrong — the mistake that used to reach
  // Postgres as NaN. It must cost its own profile only.
  await db.insert(schema.recurringProfiles).values([
    {
      organizationId: orgId,
      contactId,
      interval: "monthly",
      nextRunAt: yesterday(),
      templateJson: {
        lines: [{ description: "Broken", quantity: 1, unitPriceCents: 1000 }],
      },
    },
    {
      organizationId: orgId,
      contactId,
      interval: "monthly",
      nextRunAt: yesterday(),
      templateJson: {
        lines: [
          {
            description: "Perfectly fine",
            quantity: 1,
            unitPrice: 10000,
            taxRateBp: 0,
          },
        ],
      },
    },
  ]);

  const result = await runRecurringInvoices();
  expect(result.issued).toBe(1);
  expect(result.skipped).toHaveLength(1);
  expect(result.skipped[0]?.reason).toContain("unitPrice");

  // And the good one is a real invoice, not a partial write.
  const invoices = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));
  expect(invoices.some((i) => i.totalCents === 10000)).toBe(true);
});
