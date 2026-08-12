import { expect, test } from "bun:test";
import { type PortalInvoice, portalPage } from "./portal";

const now = new Date("2026-08-12T00:00:00Z");

const invoice = (over: Partial<PortalInvoice> = {}): PortalInvoice => ({
  id: "inv-1",
  number: "INV-1041",
  status: "open",
  currency: "USD",
  totalCents: 20000,
  paidCents: 0,
  dueDate: new Date("2026-08-20T00:00:00Z"),
  ...over,
});

test("the customer sees what they owe, not what has been billed", () => {
  // A part-paid invoice shows the balance. Showing the original amount is how
  // a customer pays twice.
  const html = portalPage({
    businessName: "Northfield Joinery",
    customerName: "Marguerite Oyelaran",
    invoices: [invoice({ totalCents: 20000, paidCents: 15000 })],
    now,
  });
  expect(html).toContain("$50.00");
  expect(html).toContain("$50.00 outstanding");
  expect(html).not.toContain("$200.00 outstanding");
});

test("overdue is shown as overdue", () => {
  const html = portalPage({
    businessName: "Northfield Joinery",
    customerName: "Marguerite",
    invoices: [invoice({ dueDate: new Date("2026-08-01T00:00:00Z") })],
    now,
  });
  expect(html).toContain("overdue");
});

test("a paid invoice is not counted as outstanding", () => {
  const html = portalPage({
    businessName: "Northfield Joinery",
    customerName: "Marguerite",
    invoices: [invoice({ status: "paid", paidCents: 20000 })],
    now,
  });
  expect(html).toContain("paid");
  expect(html).toContain("Nothing outstanding");
});

test("several invoices add up to one number", () => {
  const html = portalPage({
    businessName: "Northfield Joinery",
    customerName: "Marguerite",
    invoices: [
      invoice({ id: "a", number: "INV-1", totalCents: 12550 }),
      invoice({ id: "b", number: "INV-2", totalCents: 7500, paidCents: 2500 }),
      invoice({
        id: "c",
        number: "INV-3",
        status: "paid",
        paidCents: 30000,
        totalCents: 30000,
      }),
    ],
    now,
  });
  // 125.50 + 50.00, with the settled one excluded
  expect(html).toContain("$175.50 outstanding");
});

test("a customer with nothing owed is told so plainly", () => {
  const html = portalPage({
    businessName: "Northfield Joinery",
    customerName: "Marguerite",
    invoices: [],
    now,
  });
  expect(html).toContain("Nothing outstanding");
});

test("a business name cannot inject markup into its customer's page", () => {
  const html = portalPage({
    businessName: '<script>alert("xss")</script>',
    customerName: "<img src=x onerror=1>",
    invoices: [invoice({ number: "<b>INV</b>" })],
    now,
  });
  expect(html).not.toContain("<script>alert");
  expect(html).not.toContain("<img src=x");
  expect(html).not.toContain("<b>INV</b>");
  expect(html).toContain("&lt;script&gt;");
});

test("the page asks not to be indexed", () => {
  // The link is the credential; a search engine holding it is a leak.
  const html = portalPage({
    businessName: "Northfield Joinery",
    customerName: "Marguerite",
    invoices: [invoice()],
    now,
  });
  expect(html).toContain('name="robots" content="noindex"');
});
