import { and, eq } from "drizzle-orm";
import { db, schema } from "./index";

type Posting = { accountId: string; debitCents?: number; creditCents?: number };

/** Chart-of-accounts codes the invoicing flow posts against. */
export const CORE_ACCOUNTS = {
  cash: { code: "1000", name: "Cash", type: "asset" },
  accountsReceivable: {
    code: "1100",
    name: "Accounts Receivable",
    type: "asset",
  },
  salesIncome: { code: "4000", name: "Sales Income", type: "income" },
  /**
   * What was given away, kept apart from what was never earned.
   *
   * A contra-revenue account rather than netting discounts off income: a
   * business that discounted £4,000 to earn £40,000 wants to see both numbers,
   * and a P&L showing only £36,000 of income cannot answer whether the codes
   * were worth running.
   */
  salesDiscounts: { code: "4100", name: "Sales Discounts", type: "expense" },
  taxPayable: { code: "2200", name: "Tax Payable", type: "liability" },
  /** Where an expense lands when it has not been given an account of its own. */
  generalExpense: { code: "6000", name: "General Expenses", type: "expense" },
} as const;

/** Idempotently resolves one of the core accounts for an organization. */
export async function ensureAccount(
  orgId: string,
  account: { code: string; name: string; type: string },
): Promise<string> {
  const [existing] = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.organizationId, orgId),
        eq(schema.accounts.code, account.code),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(schema.accounts)
    .values({ organizationId: orgId, ...account })
    .returning();
  if (!created) throw new Error(`could not create account ${account.code}`);
  return created.id;
}

/** Posts a balanced journal entry or throws. Guarantees Σdebits === Σcredits. */
export async function postJournalEntry(
  orgId: string,
  memo: string,
  source: string,
  lines: Posting[],
) {
  const d = lines.reduce((s, l) => s + (l.debitCents ?? 0), 0);
  const c = lines.reduce((s, l) => s + (l.creditCents ?? 0), 0);
  if (d !== c) throw new Error(`Unbalanced entry: debits ${d} != credits ${c}`);
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(schema.journalEntries)
      .values({ organizationId: orgId, memo, source })
      .returning();
    if (!entry) throw new Error("journal entry insert returned no row");
    await tx.insert(schema.journalLines).values(
      lines.map((l) => ({
        entryId: entry.id,
        accountId: l.accountId,
        debitCents: l.debitCents ?? 0,
        creditCents: l.creditCents ?? 0,
      })),
    );
    return entry;
  });
}

/**
 * The entry raising an invoice makes: Dr Accounts Receivable, Cr Income, plus
 * any tax.
 *
 * Here rather than in the invoicing module because more than one thing raises
 * an invoice — the invoices screen, a quote being converted, and now a deal
 * that bills itself the moment a customer accepts. Every one of them has to
 * post the same entry, or revenue exists on a document and nowhere in the
 * books.
 */
export async function postInvoiceIssued(
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
