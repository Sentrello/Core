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
  taxPayable: { code: "2200", name: "Tax Payable", type: "liability" },
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
