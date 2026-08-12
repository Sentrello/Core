import { db, schema } from "@sentrello/db";
import {
  CORE_ACCOUNTS,
  ensureAccount,
  postJournalEntry,
} from "@sentrello/db/ledger";
import { MoneyError, lineTotals } from "@sentrello/db/money";
import { nextDocumentNumber } from "@sentrello/db/numbering";
import { and, eq, lte } from "drizzle-orm";
import { type Interval, nextRun } from "./dates";

type TemplateLine = {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRateBp: number;
};

/**
 * Issues invoices for every active profile whose nextRunAt has passed, then
 * advances the schedule. Each invoice posts its own balanced ledger entry.
 */
export async function runRecurringInvoices(now = new Date()) {
  const due = await db
    .select()
    .from(schema.recurringProfiles)
    .where(
      and(
        eq(schema.recurringProfiles.active, true),
        lte(schema.recurringProfiles.nextRunAt, now),
      ),
    );

  let issued = 0;
  const skipped: { profileId: string; reason: string }[] = [];
  for (const profile of due) {
    const lines = (profile.templateJson.lines ?? []) as TemplateLine[];
    const orgId = profile.organizationId;

    // One unusable template must not stop the run: every other business's
    // invoices are due today too. The profile keeps its nextRunAt, so it is
    // retried once someone fixes it rather than being silently skipped forever.
    let t: ReturnType<typeof lineTotals>;
    try {
      t = lineTotals(lines);
    } catch (err) {
      if (!(err instanceof MoneyError)) throw err;
      console.error(
        `[recurring] profile ${profile.id} has an unusable template: ${err.message}`,
      );
      skipped.push({ profileId: profile.id, reason: err.message });
      continue;
    }

    const invoice = await db.transaction(async (tx) => {
      const [inv] = await tx
        .insert(schema.invoices)
        .values({
          organizationId: orgId,
          contactId: profile.contactId,
          number: await nextDocumentNumber(tx, orgId, "invoice"),
          status: "open",
          // Recurring invoices had no due date, so overdue chasing — which
          // skips invoices without one — never saw them. These are the least
          // watched invoices a business has, which makes that the worst place
          // for them to go unasked-for. Thirty days, as elsewhere.
          dueDate: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
          subtotalCents: t.subtotal,
          taxCents: t.tax,
          totalCents: t.total,
        })
        .returning();
      if (!inv) throw new Error("recurring invoice insert returned no row");
      if (lines.length > 0) {
        await tx.insert(schema.invoiceLines).values(
          lines.map((l) => ({
            invoiceId: inv.id,
            description: l.description,
            quantity: l.quantity,
            unitPriceCents: l.unitPrice,
            taxRateBp: l.taxRateBp,
          })),
        );
      }
      await tx
        .update(schema.recurringProfiles)
        .set({
          nextRunAt: nextRun(profile.nextRunAt, profile.interval as Interval),
        })
        .where(eq(schema.recurringProfiles.id, profile.id));
      return inv;
    });

    const [ar, income, taxPayable] = await Promise.all([
      ensureAccount(orgId, CORE_ACCOUNTS.accountsReceivable),
      ensureAccount(orgId, CORE_ACCOUNTS.salesIncome),
      ensureAccount(orgId, CORE_ACCOUNTS.taxPayable),
    ]);
    await postJournalEntry(
      orgId,
      `Recurring invoice ${invoice.number}`,
      `invoice:${invoice.id}`,
      [
        { accountId: ar, debitCents: t.total },
        { accountId: income, creditCents: t.subtotal },
        ...(t.tax > 0 ? [{ accountId: taxPayable, creditCents: t.tax }] : []),
      ],
    );
    issued++;
  }

  return { issued, skipped };
}
