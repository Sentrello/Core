import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import { defineModule } from "@sentrello/module-sdk";
import { and, eq, isNull } from "drizzle-orm";

/**
 * The first screen after signing in.
 *
 * Not a report. A report is for a question somebody already has; this is for
 * the question they have not asked yet — what needs doing, and what is going
 * wrong. So it counts the things that cost money to ignore: an invoice that
 * has gone past its date, a quote nobody answered, a follow-up that was due
 * yesterday.
 *
 * Everything here reads tables Core owns. A Free instance has no Pro modules
 * and must still land somewhere useful, which is exactly the case a dashboard
 * built on Pro reporting would fail.
 */

interface Attention {
  id: string;
  kind: "invoice" | "quote" | "task";
  summary: string;
  detail: string;
  amountCents?: number;
}

export default defineModule({
  id: "dashboard",
  tier: "free",
  register(ctx) {
    // First in the sidebar and first in the nav order, because it is where
    // signing in lands — the shell takes whatever the server puts first.
    ctx.registerNav({
      id: "dashboard",
      label: "Dashboard",
      order: 1,
      group: "",
    });
    ctx.registerPermission("dashboard:read");

    ctx.app.get(
      "/api/dashboard",
      requireSession(),
      // Deliberately the widest permission in the product: everybody sees the
      // dashboard, and each panel is built from what the reader may already
      // read elsewhere.
      requirePermission({ dashboard: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const now = new Date();

        const [invoices, quotes, tasks, contacts, deals] = await Promise.all([
          db
            .select()
            .from(schema.invoices)
            .where(eq(schema.invoices.organizationId, orgId)),
          db
            .select()
            .from(schema.quotes)
            .where(eq(schema.quotes.organizationId, orgId)),
          db
            .select()
            .from(schema.tasks)
            .where(
              and(
                eq(schema.tasks.organizationId, orgId),
                eq(schema.tasks.done, false),
              ),
            ),
          db
            .select({ id: schema.contacts.id })
            .from(schema.contacts)
            .where(eq(schema.contacts.organizationId, orgId)),
          db
            .select()
            .from(schema.deals)
            .where(
              and(
                eq(schema.deals.organizationId, orgId),
                isNull(schema.deals.archivedAt),
              ),
            ),
        ]);

        // Money owed, and how much of it is late. Two numbers rather than one,
        // because "you are owed £8,000" and "£6,000 of it is overdue" call for
        // completely different afternoons.
        const unpaid = invoices.filter(
          (i) => i.status !== "paid" && i.status !== "void",
        );
        const owedCents = unpaid.reduce((sum, i) => sum + i.totalCents, 0);
        const overdue = unpaid.filter(
          (i) => i.dueDate && new Date(i.dueDate) < now,
        );
        const overdueCents = overdue.reduce((sum, i) => sum + i.totalCents, 0);

        const openDeals = deals.filter(
          (d) => d.stage !== "won" && d.stage !== "lost",
        );

        const attention: Attention[] = [
          ...overdue.map((i) => ({
            id: i.id,
            kind: "invoice" as const,
            summary: `Invoice ${i.number} is overdue`,
            detail: i.dueDate
              ? `Due ${new Date(i.dueDate).toDateString()}`
              : "",
            amountCents: i.totalCents,
          })),
          ...quotes
            .filter((q) => q.status === "sent")
            .map((q) => ({
              id: q.id,
              kind: "quote" as const,
              summary: `Quote ${q.number} is waiting on an answer`,
              detail: "Sent and not yet accepted or declined",
              amountCents: q.totalCents,
            })),
          ...tasks
            .filter((t) => t.dueAt && new Date(t.dueAt) < now)
            .map((t) => ({
              id: t.id,
              kind: "task" as const,
              summary: t.title,
              detail: t.dueAt
                ? `Was due ${new Date(t.dueAt).toDateString()}`
                : "",
            })),
        ];

        return c.json({
          money: {
            owedCents,
            overdueCents,
            unpaidCount: unpaid.length,
            overdueCount: overdue.length,
          },
          pipeline: {
            openCount: openDeals.length,
            openCents: openDeals.reduce((s, d) => s + d.amountCents, 0),
            wonCount: deals.filter((d) => d.stage === "won").length,
          },
          book: { contacts: contacts.length },
          // Most urgent first: an overdue invoice is money already earned and
          // not received, which outranks a quote nobody has answered.
          attention: attention.slice(0, 12),
        });
      },
    );
  },
});
