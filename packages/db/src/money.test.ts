import { expect, test } from "bun:test";
import { MoneyError, invoiceStatus, lineTotals } from "./money";

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

/**
 * Money arithmetic must not be able to produce a value that is not money.
 *
 * A line whose field names did not match — the shape a client gets wrong most
 * often — multiplied out to NaN, passed through the totals untouched, and
 * stopped only at Postgres, which answered with a 500 and a stack trace.
 */
test("a line with the wrong field names is rejected, not turned into NaN", () => {
  const wrong = [
    {
      description: "Consumer unit replacement",
      quantity: 1,
      unitPriceCents: 48500,
    },
  ] as unknown as Parameters<typeof lineTotals>[0];

  expect(() => lineTotals(wrong)).toThrow(MoneyError);
  expect(() => lineTotals(wrong)).toThrow(/unitPrice/);
});

test("every way a number can stop being one is refused", () => {
  const cases: [string, unknown][] = [
    ["a string price", { quantity: 1, unitPrice: "4850", taxRateBp: 0 }],
    ["a missing price", { quantity: 1, taxRateBp: 0 }],
    ["a null price", { quantity: 1, unitPrice: null, taxRateBp: 0 }],
    ["fractional cents", { quantity: 1, unitPrice: 48.5, taxRateBp: 0 }],
    [
      "an infinite price",
      { quantity: 1, unitPrice: Number.POSITIVE_INFINITY, taxRateBp: 0 },
    ],
    ["NaN quantity", { quantity: Number.NaN, unitPrice: 100, taxRateBp: 0 }],
    ["a string tax rate", { quantity: 1, unitPrice: 100, taxRateBp: "875" }],
  ];

  for (const [name, line] of cases) {
    expect(() =>
      lineTotals([line] as unknown as Parameters<typeof lineTotals>[0]),
    ).toThrow(MoneyError);
    // The message must name the line, so a five-line invoice is debuggable.
    try {
      lineTotals([line] as unknown as Parameters<typeof lineTotals>[0]);
    } catch (err) {
      expect((err as Error).message).toContain("line 1");
    }
    expect(name).toBeTruthy();
  }
});

test("the offending line is named, not just the first one", () => {
  expect(() =>
    lineTotals([
      { quantity: 1, unitPrice: 1000, taxRateBp: 0 },
      { quantity: 2, unitPrice: 2000, taxRateBp: 0 },
      { quantity: 1, unitPrice: "oops", taxRateBp: 0 },
    ] as unknown as Parameters<typeof lineTotals>[0]),
  ).toThrow(/line 3/);
});

test("a fractional quantity is allowed and lands on whole cents", () => {
  // 2.5 hours at $47.33 is 11832.5 cents before rounding — money must not
  // carry a half-cent into the ledger.
  const t = lineTotals([{ quantity: 2.5, unitPrice: 4733, taxRateBp: 0 }]);
  expect(t.subtotal).toBe(11833);
  expect(Number.isInteger(t.total)).toBe(true);
});

test("an omitted tax rate is nil tax, not a rejection", () => {
  const t = lineTotals([
    { quantity: 1, unitPrice: 5000 },
  ] as unknown as Parameters<typeof lineTotals>[0]);
  expect(t).toEqual({ subtotal: 5000, tax: 0, total: 5000 });
});
