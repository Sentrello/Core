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

/** A job a module asked the host to run. */
export interface ModuleJob {
  name: string;
  cron?: string;
  handler: () => Promise<unknown>;
}

/**
 * Starts the core queues, plus any a loaded module registered.
 *
 * Module jobs are namespaced so two modules cannot collide on a queue name,
 * and so a job left behind by a module the licence no longer loads is obvious
 * in the pg-boss tables.
 */
export async function startJobs(
  moduleJobs: ModuleJob[] = [],
  /**
   * What this instance is licensed for. Only the overdue chase needs it, to
   * decide whether the mail it sends credits Sentrello or goes out under the
   * business's own name — and a job has no request to read it from.
   */
  options: { tier?: "free" | "pro" } = {},
) {
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

  const all: ModuleJob[] = [
    { name: QUEUES.recurringInvoices, handler: () => runRecurringInvoices() },
    {
      name: QUEUES.overdueReminders,
      handler: () =>
        sendOverdueReminders(new Date(), {
          sentrelloCredit: options.tier !== "pro",
        }),
    },
    { name: QUEUES.licenseRefresh, handler: () => refreshLicenseToken() },
    ...moduleJobs,
  ];

  for (const job of all) {
    // pg-boss 10 requires the queue to exist before work()/schedule() —
    // omitting this makes both silently no-op.
    await boss.createQueue(job.name);
    await boss.work(job.name, async () => {
      await job.handler();
    });
    const cron = job.cron ?? SCHEDULES[job.name];
    if (cron) await boss.schedule(job.name, cron);
  }

  return boss;
}

export { runRecurringInvoices, sendOverdueReminders, refreshLicenseToken };
