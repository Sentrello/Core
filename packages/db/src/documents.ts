import { and, eq } from "drizzle-orm";
import { db } from "./client";
import { postInvoiceIssued } from "./ledger";
import { nextDocumentNumber } from "./numbering";
import * as schema from "./schema";

/**
 * A quote becomes an invoice.
 *
 * Lifted out of the invoicing route because a second caller arrived: Make
 * Deal converts a quote the moment a customer accepts it. A flow that
 * reimplemented this would be a second place deciding what an invoice costs
 * and whether it reached the books.
 *
 * It sits in the shared data layer rather than in the invoicing module so that
 * a commercial module can drive it without importing a Free one — every module
 * already has this package, and none of them has each other.
 *
 * Returns null when the quote is not this organization's, so the caller
 * answers 404 rather than leaking whether an id exists.
 */
/**
 * When an invoice raised from a quote falls due.
 *
 * Thirty days, because an invoice with no due date can never be late: it sits
 * outside every aging bucket, the overdue chase skips it, and it never reaches
 * the dashboard's overdue figure. A quote carries no terms of its own, so this
 * is the assumption — worth making configurable once anyone asks for different
 * terms.
 */
export function defaultDueDate(from = new Date()): Date {
  return new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
}

export async function convertQuoteToInvoice(
  organizationId: string,
  quoteId: string,
): Promise<typeof schema.invoices.$inferSelect | null> {
  const [quote] = await db
    .select()
    .from(schema.quotes)
    .where(
      and(
        eq(schema.quotes.id, quoteId),
        eq(schema.quotes.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!quote) return null;

  const lines = await db
    .select()
    .from(schema.quoteLines)
    .where(eq(schema.quoteLines.quoteId, quoteId));

  const invoice = await db.transaction(async (tx) => {
    const [inv] = await tx
      .insert(schema.invoices)
      .values({
        organizationId,
        contactId: quote.contactId,
        quoteId: quote.id,
        currency: quote.currency,
        number: await nextDocumentNumber(tx, organizationId, "invoice"),
        status: "open",
        // Without this, converting a quote produced an invoice that could
        // never be chased. The portal's own acceptance path set one; this one
        // did not, so which screen accepted the work decided whether the
        // business would ever be reminded to ask for the money.
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
      .where(eq(schema.quotes.id, quoteId));
    return inv;
  });

  // An invoice from an accepted quote is an invoice: it posts the same entry
  // as one raised directly, or the revenue exists on the invoice and nowhere
  // in the books.
  await postInvoiceIssued(organizationId, invoice);
  return invoice;
}
