import { expect, test } from "bun:test";
import { invoiceEmail, overdueReminderEmail } from "./templates";

/**
 * An invoice email is often the only copy a customer files, so it carries the
 * same identity as the portal page: the seller's address, because an invoice
 * without one is not a valid document in the UK or the EU, and how to pay,
 * because a business paid by transfer otherwise fields "where do I send this?"
 * on every invoice it raises.
 */
const seller = {
  name: "Wierzbicki Tiling",
  address: "Unit 4, Tanners Yard\nLeeds LS9 8AB",
  taxId: "GB 412 7749 02",
  taxIdLabel: "VAT number",
  paymentInstructions: "Bank transfer to 20-45-11, account 8842 3901.",
};

test("an invoice email carries the seller's details and how to pay", () => {
  const mail = invoiceEmail({
    number: "INV-0001",
    totalCents: 222000,
    currency: "GBP",
    businessName: seller.name,
    business: seller,
  });
  expect(mail.html).toContain("Unit 4, Tanners Yard<br>Leeds LS9 8AB");
  expect(mail.html).toContain("VAT number: GB 412 7749 02");
  expect(mail.html).toContain("How to pay");
  expect(mail.html).toContain("20-45-11");
});

test("the overdue chase carries them too, since it gets forwarded", () => {
  const mail = overdueReminderEmail({
    number: "INV-0001",
    balanceDueCents: 222000,
    currency: "GBP",
    business: seller,
  });
  expect(mail.html).toContain("Leeds LS9 8AB");
  expect(mail.html).toContain("20-45-11");
});

test("a business with nothing filled in gets no empty block", () => {
  const mail = invoiceEmail({
    number: "INV-0002",
    totalCents: 1000,
    currency: "GBP",
    business: { name: "Nothing Filled In" },
  });
  expect(mail.html).not.toContain("How to pay");
  expect(mail.html).not.toContain("<hr");
});

test("the seller's details cannot inject markup into an email", () => {
  const mail = invoiceEmail({
    number: "INV-0003",
    totalCents: 1000,
    currency: "GBP",
    business: { name: "X", address: "<script>alert(1)</script>" },
  });
  expect(mail.html).not.toContain("<script>");
  expect(mail.html).toContain("&lt;script&gt;");
});
