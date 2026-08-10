import { dbSsl } from "@sentrello/db/ssl";
import PgBoss from "pg-boss";
import { refreshLicenseToken } from "./license-refresh";
import { sendOverdueReminders } from "./overdue";
import { runRecurringInvoices } from "./recurring";

/** Drops `sslmode` from a connection string, leaving everything else intact. */
export function withoutSslMode(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("sslmode");
    return parsed.toString();
  } catch {
    return url; // not a URL we can parse; hand it back untouched
  }
}

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
  //
  // `sslmode` in the connection string is parsed by pg-connection-string and
  // wins over an explicit `ssl` option, so it has to come out of the URL for
  // the CA to take effect.
  const ssl = dbSsl();
  const boss = new PgBoss({
    connectionString: ssl ? withoutSslMode(url) : url,
    ...(ssl ? { ssl } : {}),
  });
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
