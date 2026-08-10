import { dbSsl } from "@sentrello/db/ssl";
import PgBoss from "pg-boss";
import { refreshLicenseToken } from "./license-refresh";
import { sendOverdueReminders } from "./overdue";
import { runRecurringInvoices } from "./recurring";

export const QUEUES = {
  recurringInvoices: "recurring-invoices",
  overdueReminders: "overdue-reminders",
  licenseRefresh: "license-refresh",
} as const;

/** cron schedules, UTC */
export const SCHEDULES: Record<string, string> = {
  [QUEUES.recurringInvoices]: "0 2 * * *",
  [QUEUES.overdueReminders]: "0 8 * * *",
  [QUEUES.licenseRefresh]: "0 3 * * *",
};

export async function startJobs() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  // pg-boss uses node-postgres, which verifies TLS strictly. A managed
  // provider's private CA has to be supplied explicitly or the connection is
  // refused with SELF_SIGNED_CERT_IN_CHAIN.
  const ssl = dbSsl();
  const boss = new PgBoss({ connectionString: url, ...(ssl ? { ssl } : {}) });
  await boss.start();

  const handlers = {
    [QUEUES.recurringInvoices]: () => runRecurringInvoices(),
    [QUEUES.overdueReminders]: () => sendOverdueReminders(),
    [QUEUES.licenseRefresh]: () => refreshLicenseToken(),
  };

  for (const [queue, handler] of Object.entries(handlers)) {
    // pg-boss 10 requires the queue to exist before work()/schedule() —
    // omitting this makes both silently no-op.
    await boss.createQueue(queue);
    await boss.work(queue, async () => {
      await handler();
    });
    const cron = SCHEDULES[queue];
    if (cron) await boss.schedule(queue, cron);
  }

  return boss;
}

export { runRecurringInvoices, sendOverdueReminders, refreshLicenseToken };
