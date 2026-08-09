/**
 * Plain template functions rather than React Email — three transactional mails
 * do not need a renderer dependency. Swap the bodies for React Email components
 * if the template set grows.
 */

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[ch] ?? ch,
  );

/** Cents -> "$1,234.56". Money is never formatted with floats upstream. */
export function formatMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    cents / 100,
  );
}

function layout(title: string, body: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">
<h1 style="font-size:18px">${escapeHtml(title)}</h1>
${body}
<p style="color:#666;font-size:12px">Sent by Sentrello</p>
</body></html>`;
}

export function welcomeEmail(name: string) {
  return {
    subject: "Welcome to Sentrello",
    html: layout(
      `Welcome, ${name}`,
      "<p>Your Sentrello instance is ready to use.</p>",
    ),
  };
}

export function invoiceEmail(args: {
  number: string;
  totalCents: number;
  currency: string;
  dueDate?: Date | null;
}) {
  const due = args.dueDate
    ? `<p>Due ${escapeHtml(args.dueDate.toISOString().slice(0, 10))}.</p>`
    : "";
  return {
    subject: `Invoice ${args.number}`,
    html: layout(
      `Invoice ${args.number}`,
      `<p>Amount due: <strong>${formatMoney(args.totalCents, args.currency)}</strong></p>${due}`,
    ),
  };
}

export function overdueReminderEmail(args: {
  number: string;
  balanceDueCents: number;
  currency: string;
}) {
  return {
    subject: `Invoice ${args.number} is overdue`,
    html: layout(
      `Invoice ${args.number} is overdue`,
      `<p>Outstanding balance: <strong>${formatMoney(args.balanceDueCents, args.currency)}</strong></p>`,
    ),
  };
}
