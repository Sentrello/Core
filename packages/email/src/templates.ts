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
  businessName?: string;
  /** the customer's own page, where they can see and settle this */
  portalUrl?: string;
}) {
  const due = args.dueDate
    ? `<p>Due ${escapeHtml(args.dueDate.toISOString().slice(0, 10))}.</p>`
    : "";
  // The link is the point of the email: an invoice a customer has to reply to
  // in order to pay is an invoice that waits.
  const link = args.portalUrl
    ? `<p><a href="${escapeHtml(args.portalUrl)}">View and pay this invoice</a></p>
<p style="color:#666;font-size:12px">This link is private to you — treat it
like a bill in the post.</p>`
    : "";
  return {
    subject: args.businessName
      ? `Invoice ${args.number} from ${args.businessName}`
      : `Invoice ${args.number}`,
    html: layout(
      `Invoice ${args.number}`,
      `<p>Amount due: <strong>${formatMoney(args.totalCents, args.currency)}</strong></p>${due}${link}`,
    ),
  };
}

export function portalLinkEmail(args: {
  businessName: string;
  url: string;
  outstandingCents?: number;
  currency?: string;
}) {
  const owed =
    args.outstandingCents && args.outstandingCents > 0
      ? `<p>Outstanding: <strong>${formatMoney(args.outstandingCents, args.currency)}</strong></p>`
      : "";
  return {
    subject: `Your invoices from ${args.businessName}`,
    html: layout(
      `Your invoices from ${args.businessName}`,
      `${owed}<p><a href="${escapeHtml(args.url)}">View your invoices</a></p>
<p style="color:#666;font-size:12px">This link is private to you — treat it
like a bill in the post. Anyone who has it can see the page.</p>`,
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
