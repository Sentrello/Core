import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import {
  CORE_ACCOUNTS,
  ensureAccount,
  postJournalEntry,
} from "@sentrello/db/ledger";
import { MoneyError, invoiceStatus, lineTotals } from "@sentrello/db/money";
import { nextDocumentNumber } from "@sentrello/db/numbering";
import { contactByPortalToken, ensurePortalToken } from "@sentrello/db/portal";
import { emailAdapter } from "@sentrello/email";
import {
  invoiceEmail,
  portalLinkEmail,
  quoteEmail,
  receiptEmail,
} from "@sentrello/email/templates";
import { defineModule } from "@sentrello/module-sdk";
import { and, eq, isNotNull } from "drizzle-orm";
import { portalPage } from "./portal";

type IncomingLine = {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRateBp: number;
};

/**
 * Tells the customer their payment landed.
 *
 * A payment that produces silence leaves someone wondering whether it went
 * through, which is the moment they email to ask. Never allowed to fail the
 * payment: the money is recorded either way.
 */
async function sendReceipt(
  orgId: string,
  invoice: {
    id: string;
    number: string;
    currency: string;
    contactId: string | null;
  },
  amountCents: number,
  balanceCents: number,
  requestUrl: string,
): Promise<void> {
  try {
    if (!invoice.contactId) return;
    const [contact] = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, invoice.contactId))
      .limit(1);
    if (!contact?.email) return;

    const token = await ensurePortalToken(contact);
    const base = process.env.SENTRELLO_BASE_URL ?? new URL(requestUrl).origin;
    const [org] = await db
      .select({ name: schema.organizations.name })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId))
      .limit(1);

    await emailAdapter().send({
      to: contact.email,
      ...receiptEmail({
        number: invoice.number,
        amountCents,
        currency: invoice.currency,
        balanceCents,
        businessName: org?.name,
        portalUrl: `${base}/portal/${token}`,
      }),
    });
  } catch (err) {
    console.error("[invoicing] sending the receipt failed", err);
  }
}

/**
 * When an invoice raised from a quote falls due.
 *
 * Thirty days, because an invoice with no due date can never be late: it sits
 * outside every aging bucket and never appears on the list of who owes you.
 * A quote carries no terms of its own, so this is the assumption — worth
 * making configurable once anyone asks for different terms.
 */
function defaultDueDate(): Date {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
}

/**
 * The entry raising an invoice makes: Dr Accounts Receivable, Cr Income, plus
 * any tax. Shared so every path that issues an invoice posts the same thing.
 */
async function postInvoiceIssued(
  orgId: string,
  invoice: {
    id: string;
    number: string;
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
  },
): Promise<void> {
  const [ar, income, taxPayable] = await Promise.all([
    ensureAccount(orgId, CORE_ACCOUNTS.accountsReceivable),
    ensureAccount(orgId, CORE_ACCOUNTS.salesIncome),
    ensureAccount(orgId, CORE_ACCOUNTS.taxPayable),
  ]);
  await postJournalEntry(
    orgId,
    `Invoice ${invoice.number}`,
    `invoice:${invoice.id}`,
    [
      { accountId: ar, debitCents: invoice.totalCents },
      { accountId: income, creditCents: invoice.subtotalCents },
      ...(invoice.taxCents > 0
        ? [{ accountId: taxPayable, creditCents: invoice.taxCents }]
        : []),
    ],
  );
}

export default defineModule({
  id: "invoicing",
  tier: "free",
  register(ctx) {
    ctx.registerNav({ id: "invoicing", label: "Invoices", order: 20 });
    ctx.registerNav({ id: "quotes", label: "Quotes", order: 19 });
    for (const p of ["read", "create", "update", "delete", "send"]) {
      ctx.registerPermission(`invoicing:${p}`);
    }

    ctx.app.get(
      "/api/invoices",
      requireSession(),
      requirePermission({ invoicing: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const rows = await db
          .select()
          .from(schema.invoices)
          .where(eq(schema.invoices.organizationId, orgId));
        return c.json({ invoices: rows });
      },
    );

    ctx.app.post(
      "/api/invoices",
      requireSession(),
      requirePermission({ invoicing: ["create"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const { contactId, currency, dueDate, lines } = await c.req.json();
        const incoming: IncomingLine[] = lines ?? [];

        // A malformed line is the client's mistake, not a server fault: say
        // which line and what is wrong with it rather than answering 500.
        let t: ReturnType<typeof lineTotals>;
        try {
          t = lineTotals(incoming);
        } catch (err) {
          if (err instanceof MoneyError) {
            return c.json({ error: err.message }, 400);
          }
          throw err;
        }

        const invoice = await db.transaction(async (tx) => {
          const [inv] = await tx
            .insert(schema.invoices)
            .values({
              organizationId: orgId,
              contactId,
              currency,
              // Defaulted rather than left null: overdue chasing skips an
              // invoice with no due date, so one created without a date is
              // money the business is never reminded to ask for.
              dueDate: dueDate ? new Date(dueDate) : defaultDueDate(),
              number: await nextDocumentNumber(tx, orgId, "invoice"),
              status: "open",
              subtotalCents: t.subtotal,
              taxCents: t.tax,
              totalCents: t.total,
            })
            .returning();
          if (!inv) throw new Error("invoice insert returned no row");
          if (incoming.length > 0) {
            await tx.insert(schema.invoiceLines).values(
              incoming.map((l) => ({
                invoiceId: inv.id,
                description: l.description,
                quantity: l.quantity,
                unitPriceCents: l.unitPrice,
                taxRateBp: l.taxRateBp,
              })),
            );
          }
          return inv;
        });

        // Issuing an invoice is an accounting event: Dr AR / Cr Income + Tax.
        const [ar, income, taxPayable] = await Promise.all([
          ensureAccount(orgId, CORE_ACCOUNTS.accountsReceivable),
          ensureAccount(orgId, CORE_ACCOUNTS.salesIncome),
          ensureAccount(orgId, CORE_ACCOUNTS.taxPayable),
        ]);
        await postJournalEntry(
          orgId,
          `Invoice ${invoice.number}`,
          `invoice:${invoice.id}`,
          [
            { accountId: ar, debitCents: t.total },
            { accountId: income, creditCents: t.subtotal },
            ...(t.tax > 0
              ? [{ accountId: taxPayable, creditCents: t.tax }]
              : []),
          ],
        );

        return c.json({ invoice }, 201);
      },
    );

    // Record a payment (full or partial): posts Dr Cash / Cr AR and recomputes
    // the invoice status from the ledger-backed payment total.
    ctx.app.post(
      "/api/invoices/:id/payments",
      requireSession(),
      requirePermission({ invoicing: ["update"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const invoiceId = c.req.param("id");
        const { amountCents, method, gatewayRef } = await c.req.json();
        if (!Number.isInteger(amountCents) || amountCents <= 0) {
          return c.json(
            { error: "amountCents must be a positive integer" },
            400,
          );
        }

        const [invoice] = await db
          .select()
          .from(schema.invoices)
          .where(
            and(
              eq(schema.invoices.id, invoiceId),
              eq(schema.invoices.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!invoice) return c.json({ error: "not found" }, 404);

        const [payment] = await db
          .insert(schema.payments)
          .values({
            organizationId: orgId,
            invoiceId,
            amountCents,
            method: method ?? "manual",
            gatewayRef,
          })
          .returning();
        if (!payment) throw new Error("payment insert returned no row");

        const paid = await db
          .select({ amountCents: schema.payments.amountCents })
          .from(schema.payments)
          .where(
            and(
              eq(schema.payments.invoiceId, invoiceId),
              eq(schema.payments.organizationId, orgId),
            ),
          );
        const paidCents = paid.reduce((s, p) => s + p.amountCents, 0);
        const { status, balanceDue } = invoiceStatus(
          invoice.totalCents,
          paidCents,
        );

        await db
          .update(schema.invoices)
          .set({ status })
          .where(eq(schema.invoices.id, invoiceId));

        const [cash, ar] = await Promise.all([
          ensureAccount(orgId, CORE_ACCOUNTS.cash),
          ensureAccount(orgId, CORE_ACCOUNTS.accountsReceivable),
        ]);
        await postJournalEntry(
          orgId,
          `Payment for ${invoice.number}`,
          `payment:${payment.id}`,
          [
            { accountId: cash, debitCents: amountCents },
            { accountId: ar, creditCents: amountCents },
          ],
        );

        await sendReceipt(orgId, invoice, amountCents, balanceDue, c.req.url);

        return c.json({ payment, status, balanceDue }, 201);
      },
    );

    ctx.app.get(
      "/api/quotes",
      requireSession(),
      requirePermission({ invoicing: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        return c.json({
          quotes: await db
            .select()
            .from(schema.quotes)
            .where(eq(schema.quotes.organizationId, orgId)),
        });
      },
    );

    /**
     * Sending a quote to the customer.
     *
     * Marking it sent is what puts it on their portal page — a draft is the
     * business still thinking. The two happen together because a quote marked
     * sent that nobody sent is worse than either alone.
     */
    ctx.app.post(
      "/api/quotes/:id/send",
      requireSession(),
      requirePermission({ invoicing: ["send"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const [quote] = await db
          .select()
          .from(schema.quotes)
          .where(
            and(
              eq(schema.quotes.id, c.req.param("id")),
              eq(schema.quotes.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!quote) return c.json({ error: "not found" }, 404);
        if (!quote.contactId) {
          return c.json({ error: "this quote has no customer" }, 400);
        }

        const [contact] = await db
          .select()
          .from(schema.contacts)
          .where(eq(schema.contacts.id, quote.contactId))
          .limit(1);
        if (!contact?.email) {
          return c.json({ error: "that customer has no email address" }, 400);
        }

        const token = await ensurePortalToken(contact);
        const base =
          process.env.SENTRELLO_BASE_URL ?? new URL(c.req.url).origin;
        const [org] = await db
          .select({ name: schema.organizations.name })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, orgId))
          .limit(1);

        try {
          await emailAdapter().send({
            to: contact.email,
            ...quoteEmail({
              number: quote.number,
              totalCents: quote.totalCents,
              currency: quote.currency,
              businessName: org?.name,
              portalUrl: `${base}/portal/${token}`,
            }),
          });
        } catch (err) {
          console.error("[invoicing] sending the quote failed", err);
          return c.json({ error: "could not send it" }, 502);
        }

        // Only now: a quote the customer can see is one that actually went.
        const [updated] = await db
          .update(schema.quotes)
          .set({ status: "sent" })
          .where(eq(schema.quotes.id, quote.id))
          .returning();

        await db.insert(schema.activities).values({
          organizationId: orgId,
          contactId: contact.id,
          type: "note",
          body: `Sent quote ${quote.number} to ${contact.email}`,
          occurredAt: new Date(),
        });

        return c.json({ quote: updated, sent: true, to: contact.email });
      },
    );

    ctx.app.post(
      "/api/quotes",
      requireSession(),
      requirePermission({ invoicing: ["create"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const { contactId, currency, lines } = await c.req.json();
        const incoming: IncomingLine[] = lines ?? [];

        let t: ReturnType<typeof lineTotals>;
        try {
          t = lineTotals(incoming);
        } catch (err) {
          if (err instanceof MoneyError) {
            return c.json({ error: err.message }, 400);
          }
          throw err;
        }

        const quote = await db.transaction(async (tx) => {
          const [q] = await tx
            .insert(schema.quotes)
            .values({
              organizationId: orgId,
              contactId,
              currency,
              number: await nextDocumentNumber(tx, orgId, "quote"),
              subtotalCents: t.subtotal,
              taxCents: t.tax,
              totalCents: t.total,
            })
            .returning();
          if (!q) throw new Error("quote insert returned no row");
          if (incoming.length > 0) {
            await tx.insert(schema.quoteLines).values(
              incoming.map((l) => ({
                quoteId: q.id,
                description: l.description,
                quantity: l.quantity,
                unitPriceCents: l.unitPrice,
                taxRateBp: l.taxRateBp,
              })),
            );
          }
          return q;
        });

        return c.json({ quote }, 201);
      },
    );

    // Convert a quote to an invoice: copies the lines and links quoteId.
    ctx.app.post(
      "/api/quotes/:id/convert",
      requireSession(),
      requirePermission({ invoicing: ["create"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const quoteId = c.req.param("id");

        const [quote] = await db
          .select()
          .from(schema.quotes)
          .where(
            and(
              eq(schema.quotes.id, quoteId),
              eq(schema.quotes.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!quote) return c.json({ error: "not found" }, 404);

        const lines = await db
          .select()
          .from(schema.quoteLines)
          .where(eq(schema.quoteLines.quoteId, quoteId));

        const invoice = await db.transaction(async (tx) => {
          const [inv] = await tx
            .insert(schema.invoices)
            .values({
              organizationId: orgId,
              contactId: quote.contactId,
              quoteId: quote.id,
              currency: quote.currency,
              number: await nextDocumentNumber(tx, orgId, "invoice"),
              status: "open",
              subtotalCents: quote.subtotalCents,
              taxCents: quote.taxCents,
              totalCents: quote.totalCents,
            })
            .returning();
          if (!inv) throw new Error("invoice insert returned no row");
          if (lines.length > 0) {
            await tx.insert(schema.invoiceLines).values(
              lines.map((l) => ({
                invoiceId: inv.id,
                description: l.description,
                quantity: l.quantity,
                unitPriceCents: l.unitPriceCents,
                taxRateBp: l.taxRateBp,
              })),
            );
          }
          await tx
            .update(schema.quotes)
            .set({ status: "accepted" })
            .where(eq(schema.quotes.id, quoteId));
          return inv;
        });

        // An invoice from an accepted quote is an invoice: it posts the same
        // entry as one raised directly, or the revenue exists on the invoice
        // and nowhere in the books.
        await postInvoiceIssued(orgId, invoice);

        return c.json({ invoice }, 201);
      },
    );

    /**
     * Customer portal. The `customer` role only grants invoicing:read, which is
     * NOT enough on its own — RBAC cannot express "only your own rows". The
     * portal user is resolved to their contact record and the query is filtered
     * to that contact, so a customer can never read another customer's invoice.
     */
    /**
     * Mints the link a customer follows to see what they owe.
     *
     * `?rotate=1` reissues it, which is how a business takes a shared link out
     * of circulation.
     */
    ctx.app.post(
      "/api/contacts/:id/portal-link",
      requireSession(),
      requirePermission({ invoicing: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const [contact] = await db
          .select()
          .from(schema.contacts)
          .where(
            and(
              eq(schema.contacts.id, c.req.param("id")),
              eq(schema.contacts.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!contact) return c.json({ error: "not found" }, 404);

        const token =
          c.req.query("rotate") === "1"
            ? await ensurePortalToken(contact, true)
            : await ensurePortalToken(contact);

        const base =
          process.env.SENTRELLO_BASE_URL ?? new URL(c.req.url).origin;
        const url = `${base}/portal/${token}`;

        // Sending is the point: a link the business has to copy out of a
        // dialog and paste into their own email client is a link that stays
        // in the dialog.
        if (c.req.query("send") === "1") {
          if (!contact.email) {
            return c.json({ error: "this contact has no email address" }, 400);
          }

          const rows = await db
            .select()
            .from(schema.invoices)
            .where(
              and(
                eq(schema.invoices.organizationId, orgId),
                eq(schema.invoices.contactId, contact.id),
              ),
            );
          const paid = await db
            .select({
              invoiceId: schema.payments.invoiceId,
              amountCents: schema.payments.amountCents,
            })
            .from(schema.payments)
            .where(eq(schema.payments.organizationId, orgId));

          const outstandingCents = rows.reduce((sum, invoice) => {
            const settled = paid
              .filter((p) => p.invoiceId === invoice.id)
              .reduce((n, p) => n + p.amountCents, 0);
            return sum + Math.max(0, invoice.totalCents - settled);
          }, 0);

          const [org] = await db
            .select({ name: schema.organizations.name })
            .from(schema.organizations)
            .where(eq(schema.organizations.id, orgId))
            .limit(1);

          try {
            await emailAdapter().send({
              to: contact.email,
              ...portalLinkEmail({
                businessName: org?.name ?? "Your supplier",
                url,
                outstandingCents,
                currency: rows[0]?.currency,
              }),
            });
          } catch (err) {
            // The link exists either way; the business can still copy it.
            console.error("[invoicing] portal link email failed", err);
            return c.json({ url, sent: false }, 502);
          }
          return c.json({ url, sent: true });
        }

        return c.json({ url });
      },
    );

    /**
     * The customer's own page. Unauthenticated by necessity — they have no
     * account — so the token is compared in constant time and a wrong one is
     * a 404, which is what an unknown URL looks like.
     */
    ctx.app.get("/portal/:token", async (c) => {
      const supplied = c.req.param("token");
      const contact = await contactByPortalToken(supplied);
      if (!contact) return c.notFound();

      const rows = await db
        .select()
        .from(schema.invoices)
        .where(
          and(
            eq(schema.invoices.organizationId, contact.organizationId),
            eq(schema.invoices.contactId, contact.id),
          ),
        );

      const paid = await db
        .select({
          invoiceId: schema.payments.invoiceId,
          amountCents: schema.payments.amountCents,
        })
        .from(schema.payments)
        .where(eq(schema.payments.organizationId, contact.organizationId));

      const [org] = await db
        // The whole row: the portal footer needs the address, tax number and
        // payment instructions, not only the name.
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.id, contact.organizationId))
        .limit(1);

      const quotes = await db
        .select()
        .from(schema.quotes)
        .where(
          and(
            eq(schema.quotes.organizationId, contact.organizationId),
            eq(schema.quotes.contactId, contact.id),
          ),
        );

      return c.html(
        portalPage({
          businessName: org?.name ?? "Invoices",
          // On a Free instance with no card payments this footer is the only
          // thing telling the customer where to send the money.
          business: {
            name: org?.name ?? "Invoices",
            address: org?.address,
            taxId: org?.taxId,
            taxIdLabel: org?.taxIdLabel,
            paymentInstructions: org?.paymentInstructions,
          },
          customerName: contact.name,
          quotes,
          quotePath: `/portal/${supplied}/quotes`,
          // Paying online is a Pro feature; a Free instance shows the bill and
          // leaves the customer to pay however they already do.
          payPath: ctx.entitled({ tier: "pro" })
            ? `/portal/${supplied}/pay`
            : undefined,
          invoices: rows.map((invoice) => ({
            ...invoice,
            paidCents: paid
              .filter((p) => p.invoiceId === invoice.id)
              .reduce((sum, p) => sum + p.amountCents, 0),
          })),
        }),
        200,
        { "x-robots-tag": "noindex" },
      );
    });

    /**
     * Sending an invoice to the customer.
     *
     * The template existed and nothing called it, so a business could raise an
     * invoice and had no way to deliver it. The email carries the customer's
     * portal link, because an invoice someone has to reply to in order to pay
     * is an invoice that waits.
     */
    /**
     * One invoice, with everything a person needs to answer "where is this?":
     * what was charged, what has been paid, and what is left.
     *
     * The balance is computed from the payments rather than stored, so a row
     * that was hand-edited in the database cannot disagree with itself.
     */
    ctx.app.get(
      "/api/invoices/:id",
      requireSession(),
      requirePermission({ invoicing: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const [invoice] = await db
          .select()
          .from(schema.invoices)
          .where(
            and(
              eq(schema.invoices.id, c.req.param("id")),
              eq(schema.invoices.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!invoice) return c.json({ error: "not found" }, 404);

        const [lines, payments] = await Promise.all([
          db
            .select()
            .from(schema.invoiceLines)
            .where(eq(schema.invoiceLines.invoiceId, invoice.id)),
          db
            .select()
            .from(schema.payments)
            .where(eq(schema.payments.invoiceId, invoice.id)),
        ]);

        const paidCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
        const { balanceDue, status } = invoiceStatus(
          invoice.totalCents,
          paidCents,
        );

        return c.json({
          invoice,
          lines,
          payments,
          paidCents,
          balanceDue,
          // What the status would be from the payments alone, so a stale
          // stored status is visible rather than believed.
          computedStatus: status,
        });
      },
    );

    ctx.app.post(
      "/api/invoices/:id/send",
      requireSession(),
      requirePermission({ invoicing: ["send"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const [invoice] = await db
          .select()
          .from(schema.invoices)
          .where(
            and(
              eq(schema.invoices.id, c.req.param("id")),
              eq(schema.invoices.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!invoice) return c.json({ error: "not found" }, 404);
        if (!invoice.contactId) {
          return c.json({ error: "this invoice has no customer" }, 400);
        }

        const [contact] = await db
          .select()
          .from(schema.contacts)
          .where(eq(schema.contacts.id, invoice.contactId))
          .limit(1);
        if (!contact?.email) {
          return c.json({ error: "that customer has no email address" }, 400);
        }

        const token = await ensurePortalToken(contact);
        const base =
          process.env.SENTRELLO_BASE_URL ?? new URL(c.req.url).origin;
        const [org] = await db
          .select({ name: schema.organizations.name })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, orgId))
          .limit(1);

        try {
          await emailAdapter().send({
            to: contact.email,
            ...invoiceEmail({
              number: invoice.number,
              totalCents: invoice.totalCents,
              currency: invoice.currency,
              dueDate: invoice.dueDate,
              businessName: org?.name,
              portalUrl: `${base}/portal/${token}`,
            }),
          });
        } catch (err) {
          console.error("[invoicing] sending the invoice failed", err);
          return c.json({ error: "could not send it" }, 502);
        }

        // What was sent, and when, belongs on the customer's timeline: it is
        // the answer to "did we ever actually invoice them?"
        await db.insert(schema.activities).values({
          organizationId: orgId,
          contactId: contact.id,
          type: "note",
          body: `Sent invoice ${invoice.number} to ${contact.email}`,
          occurredAt: new Date(),
        });

        return c.json({ sent: true, to: contact.email });
      },
    );

    /**
     * The customer accepting a quote.
     *
     * This is the one thing a customer can change from their own page, so it
     * is narrow on purpose: only their own quote, only one the business has
     * sent, and only into the invoice the business already priced.
     */
    ctx.app.post("/portal/:token/quotes/:id/accept", async (c) => {
      const token = c.req.param("token");
      const contact = await contactByPortalToken(token);
      if (!contact) return c.notFound();

      const [quote] = await db
        .select()
        .from(schema.quotes)
        .where(
          and(
            eq(schema.quotes.id, c.req.param("id")),
            eq(schema.quotes.organizationId, contact.organizationId),
            eq(schema.quotes.contactId, contact.id),
          ),
        )
        .limit(1);
      // A quote already answered is not answerable again: accepting twice
      // would raise a second invoice for the same work.
      if (!quote || quote.status !== "sent") return c.notFound();

      const lines = await db
        .select()
        .from(schema.quoteLines)
        .where(eq(schema.quoteLines.quoteId, quote.id));

      const invoice = await db.transaction(async (tx) => {
        const [inv] = await tx
          .insert(schema.invoices)
          .values({
            organizationId: contact.organizationId,
            contactId: contact.id,
            quoteId: quote.id,
            currency: quote.currency,
            number: await nextDocumentNumber(
              tx,
              contact.organizationId,
              "invoice",
            ),
            status: "open",
            dueDate: defaultDueDate(),
            subtotalCents: quote.subtotalCents,
            taxCents: quote.taxCents,
            totalCents: quote.totalCents,
          })
          .returning();
        if (!inv) throw new Error("invoice insert returned no row");
        if (lines.length > 0) {
          await tx.insert(schema.invoiceLines).values(
            lines.map((l) => ({
              invoiceId: inv.id,
              description: l.description,
              quantity: l.quantity,
              unitPriceCents: l.unitPriceCents,
              taxRateBp: l.taxRateBp,
            })),
          );
        }
        await tx
          .update(schema.quotes)
          .set({ status: "accepted" })
          .where(eq(schema.quotes.id, quote.id));
        return inv;
      });

      await postInvoiceIssued(contact.organizationId, invoice);

      // The business should find out from its own timeline, not by noticing.
      await db.insert(schema.activities).values({
        organizationId: contact.organizationId,
        contactId: contact.id,
        type: "note",
        body: `Accepted quote ${quote.number} — invoice ${invoice.number} raised`,
        occurredAt: new Date(),
      });

      return c.redirect(`/portal/${token}`, 303);
    });

    ctx.app.get(
      "/api/portal/invoices",
      requireSession(),
      requirePermission({ invoicing: ["read"] }),
      async (c) => {
        const session = c.get("session");
        const orgId = activeOrganizationId(session);

        const [contact] = await db
          .select({ id: schema.contacts.id })
          .from(schema.contacts)
          .where(
            and(
              eq(schema.contacts.organizationId, orgId),
              eq(schema.contacts.portalUserId, session.user.id),
            ),
          )
          .limit(1);
        if (!contact) return c.json({ invoices: [] });

        const rows = await db
          .select()
          .from(schema.invoices)
          .where(
            and(
              eq(schema.invoices.organizationId, orgId),
              eq(schema.invoices.contactId, contact.id),
            ),
          );
        return c.json({ invoices: rows });
      },
    );
  },
});
