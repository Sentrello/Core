import { expect, test } from "bun:test";
import { type PortalInvoice, type PortalQuote, portalPage } from "./portal";

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

const quote = (over: Partial<PortalQuote> = {}): PortalQuote => ({
  id: "q-1",
  number: "QUO-2001",
  status: "sent",
  currency: "USD",
  totalCents: 45000,
  ...over,
});

test("a sent quote is offered for approval", () => {
  const html = portalPage({
    businessName: "Northfield Joinery",
    customerName: "Marguerite",
    invoices: [],
    quotes: [quote()],
    quotePath: "/portal/tok/quotes",
    now,
  });
  expect(html).toContain("QUO-2001");
  expect(html).toContain("$450.00");
  expect(html).toContain("/portal/tok/quotes/q-1/accept");
  expect(html).toContain("Accept");
});

test("a draft quote is the business thinking out loud, not the customer's business", () => {
  const html = portalPage({
    businessName: "Northfield Joinery",
    customerName: "Marguerite",
    invoices: [],
    quotes: [quote({ status: "draft", number: "QUO-DRAFT" })],
    quotePath: "/portal/tok/quotes",
    now,
  });
  expect(html).not.toContain("QUO-DRAFT");
});

test("an answered quote is not offered again", () => {
  const html = portalPage({
    businessName: "Northfield Joinery",
    customerName: "Marguerite",
    invoices: [],
    quotes: [
      quote({ status: "accepted", number: "QUO-DONE" }),
      quote({ status: "declined", number: "QUO-NO" }),
    ],
    quotePath: "/portal/tok/quotes",
    now,
  });
  expect(html).not.toContain("QUO-DONE");
  expect(html).not.toContain("QUO-NO");
  expect(html).not.toContain("Quotes for you to approve");
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
