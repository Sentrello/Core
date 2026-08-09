import { db, schema } from "@sentrello/db";
import { invoiceStatus } from "@sentrello/db/money";
import { emailAdapter } from "@sentrello/email";
import { overdueReminderEmail } from "@sentrello/email/templates";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { isOverdue } from "./dates";

/** Don't nag: at most one reminder per invoice per this many hours. */
const REMINDER_INTERVAL_HOURS = 24 * 7;

export async function sendOverdueReminders(now = new Date()) {
  const candidates = await db
    .select()
    .from(schema.invoices)
    .where(
      and(
        inArray(schema.invoices.status, ["open", "partial"]),
        isNotNull(schema.invoices.dueDate),
      ),
    );

  const mailer = emailAdapter();
  let sent = 0;

  for (const invoice of candidates) {
    if (!invoice.dueDate) continue;

    const paid = await db
      .select({ amountCents: schema.payments.amountCents })
      .from(schema.payments)
      .where(eq(schema.payments.invoiceId, invoice.id));
    const paidCents = paid.reduce((s, p) => s + p.amountCents, 0);
    const { balanceDue } = invoiceStatus(invoice.totalCents, paidCents);

    if (!isOverdue(invoice.dueDate, balanceDue, now)) continue;

    const throttledUntil = invoice.lastReminderAt
      ? invoice.lastReminderAt.getTime() +
        REMINDER_INTERVAL_HOURS * 60 * 60 * 1000
      : 0;
    if (now.getTime() < throttledUntil) continue;

    const [contact] = invoice.contactId
      ? await db
          .select({ email: schema.contacts.email })
          .from(schema.contacts)
          .where(eq(schema.contacts.id, invoice.contactId))
          .limit(1)
      : [];
    if (!contact?.email) continue;

    const mail = overdueReminderEmail({
      number: invoice.number,
      balanceDueCents: balanceDue,
      currency: invoice.currency,
    });
    await mailer.send({ to: contact.email, ...mail });

    await db
      .update(schema.invoices)
      .set({ lastReminderAt: now })
      .where(eq(schema.invoices.id, invoice.id));
    sent++;
  }

  return { sent };
}
