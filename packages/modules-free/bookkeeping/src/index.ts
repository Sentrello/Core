import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import { defineModule } from "@sentrello/module-sdk";
import { and, eq } from "drizzle-orm";

export default defineModule({
  id: "bookkeeping",
  tier: "free",
  register(ctx) {
    ctx.registerNav({ id: "bookkeeping", label: "Bookkeeping", order: 30 });
    for (const p of ["read", "create", "update", "delete"]) {
      ctx.registerPermission(`bookkeeping:${p}`);
    }
    ctx.registerPermission("reports:read");

    // --- chart of accounts ---
    ctx.app.get(
      "/api/accounts",
      requireSession(),
      requirePermission({ bookkeeping: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const rows = await db
          .select()
          .from(schema.accounts)
          .where(eq(schema.accounts.organizationId, orgId));
        return c.json({ accounts: rows });
      },
    );

    ctx.app.post(
      "/api/accounts",
      requireSession(),
      requirePermission({ bookkeeping: ["create"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const { code, name, type } = await c.req.json();
        const [row] = await db
          .insert(schema.accounts)
          .values({ organizationId: orgId, code, name, type })
          .returning();
        return c.json({ account: row }, 201);
      },
    );

    // --- expenses ---
    ctx.app.get(
      "/api/expenses",
      requireSession(),
      requirePermission({ bookkeeping: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const rows = await db
          .select()
          .from(schema.expenses)
          .where(eq(schema.expenses.organizationId, orgId));
        return c.json({ expenses: rows });
      },
    );

    ctx.app.post(
      "/api/expenses",
      requireSession(),
      requirePermission({ bookkeeping: ["create"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const body = await c.req.json();
        if (!Number.isInteger(body.amountCents)) {
          return c.json({ error: "amountCents must be integer cents" }, 400);
        }
        const [row] = await db
          .insert(schema.expenses)
          .values({
            organizationId: orgId,
            accountId: body.accountId,
            amountCents: body.amountCents,
            vendor: body.vendor,
            receiptFileKey: body.receiptFileKey,
            ...(body.spentAt ? { spentAt: new Date(body.spentAt) } : {}),
          })
          .returning();
        return c.json({ expense: row }, 201);
      },
    );

    // --- journal (read-only; everything posts through postJournalEntry) ---
    ctx.app.get(
      "/api/journal",
      requireSession(),
      requirePermission({ bookkeeping: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const rows = await db
          .select({
            id: schema.journalEntries.id,
            memo: schema.journalEntries.memo,
            source: schema.journalEntries.source,
            postedAt: schema.journalEntries.postedAt,
            debitCents: schema.journalLines.debitCents,
            creditCents: schema.journalLines.creditCents,
            accountId: schema.journalLines.accountId,
          })
          .from(schema.journalEntries)
          .innerJoin(
            schema.journalLines,
            eq(schema.journalLines.entryId, schema.journalEntries.id),
          )
          .where(eq(schema.journalEntries.organizationId, orgId));
        return c.json({ lines: rows });
      },
    );

    /**
     * Basic P&L, computed from the ledger — the ledger is the source of truth
     * for reports, never the invoice/expense tables.
     */
    ctx.app.get(
      "/api/reports/profit-and-loss",
      requireSession(),
      requirePermission({ reports: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const rows = await db
          .select({
            type: schema.accounts.type,
            debitCents: schema.journalLines.debitCents,
            creditCents: schema.journalLines.creditCents,
          })
          .from(schema.journalLines)
          .innerJoin(
            schema.journalEntries,
            eq(schema.journalLines.entryId, schema.journalEntries.id),
          )
          .innerJoin(
            schema.accounts,
            eq(schema.journalLines.accountId, schema.accounts.id),
          )
          .where(
            and(
              eq(schema.journalEntries.organizationId, orgId),
              eq(schema.accounts.organizationId, orgId),
            ),
          );

        // income accounts carry credit balances, expense accounts debit balances
        let incomeCents = 0;
        let expenseCents = 0;
        for (const r of rows) {
          if (r.type === "income") incomeCents += r.creditCents - r.debitCents;
          if (r.type === "expense")
            expenseCents += r.debitCents - r.creditCents;
        }
        return c.json({
          incomeCents,
          expenseCents,
          netCents: incomeCents - expenseCents,
        });
      },
    );
  },
});
