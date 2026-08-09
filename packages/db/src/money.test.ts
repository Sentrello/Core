import { expect, test } from "bun:test";
import { invoiceStatus, lineTotals } from "./money";

test("lineTotals sums integer cents with per-line tax", () => {
  const t = lineTotals([
    { quantity: 2, unitPrice: 5000, taxRateBp: 875 }, // 10000 net, 875 tax
    { quantity: 1, unitPrice: 2500, taxRateBp: 0 }, // 2500 net, 0 tax
  ]);
  expect(t).toEqual({ subtotal: 12500, tax: 875, total: 13375 });
});

test("tax rounds per line, not on the invoice total", () => {
  // 333 * 875bp = 29.1375 -> 29 per line; three lines = 87, not round(87.4125) = 87
  const perLine = lineTotals([
    { quantity: 1, unitPrice: 333, taxRateBp: 875 },
    { quantity: 1, unitPrice: 333, taxRateBp: 875 },
    { quantity: 1, unitPrice: 333, taxRateBp: 875 },
  ]);
  expect(perLine.tax).toBe(87);
  expect(perLine.total).toBe(1086);
});

test("every total is an integer number of cents", () => {
  const t = lineTotals([{ quantity: 3, unitPrice: 1999, taxRateBp: 725 }]);
  expect(Number.isInteger(t.subtotal)).toBe(true);
  expect(Number.isInteger(t.tax)).toBe(true);
  expect(Number.isInteger(t.total)).toBe(true);
  expect(t).toEqual({ subtotal: 5997, tax: 435, total: 6432 });
});

test("empty invoice totals zero", () => {
  expect(lineTotals([])).toEqual({ subtotal: 0, tax: 0, total: 0 });
});

test("invoiceStatus tracks open, partial, and paid", () => {
  expect(invoiceStatus(10000, 0)).toEqual({
    balanceDue: 10000,
    status: "open",
  });
  expect(invoiceStatus(10000, 2500)).toEqual({
    balanceDue: 7500,
    status: "partial",
  });
  expect(invoiceStatus(10000, 10000)).toEqual({
    balanceDue: 0,
    status: "paid",
  });
});

test("overpayment is paid, never negative status", () => {
  expect(invoiceStatus(10000, 12000)).toEqual({
    balanceDue: -2000,
    status: "paid",
  });
});
