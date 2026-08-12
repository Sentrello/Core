export type TaxedLine = {
  quantity: number;
  unitPrice: number;
  taxRateBp: number;
};

/**
 * Money is integer cents and tax is basis points, so anything else is a bug
 * upstream — a missing field, a string from a form, a float from a spreadsheet.
 *
 * This used to let it through: a line with the wrong field name multiplied out
 * to NaN, sailed through the totals, and only stopped at Postgres, which
 * answered with a 500 and a stack trace. Money arithmetic must not be able to
 * produce a value that is not money, and the failure belongs here, where every
 * caller routes through, rather than in each route that builds a line.
 */
export class MoneyError extends Error {}

function cents(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MoneyError(`${field} must be a number in cents`);
  }
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${field} must be a whole number of cents`);
  }
  return value;
}

export function lineTotals(lines: TaxedLine[]) {
  let subtotal = 0;
  let tax = 0;
  for (const [i, l] of lines.entries()) {
    // Quantity may legitimately be fractional — 2.5 hours, 1.5 metres — so it
    // is checked for being a finite number, not for being whole.
    const quantity = l?.quantity;
    if (typeof quantity !== "number" || !Number.isFinite(quantity)) {
      throw new MoneyError(`line ${i + 1}: quantity must be a number`);
    }
    const unitPrice = cents(l?.unitPrice, `line ${i + 1}: unitPrice`);
    const taxRateBp = cents(l?.taxRateBp ?? 0, `line ${i + 1}: taxRateBp`);

    // Rounded per line: a fractional quantity times a price in cents is not
    // necessarily a whole number of cents, and the total must be.
    const net = Math.round(quantity * unitPrice);
    subtotal += net;
    tax += Math.round((net * taxRateBp) / 10000);
  }
  return { subtotal, tax, total: subtotal + tax };
}

export function invoiceStatus(totalCents: number, paidCents: number) {
  const due = totalCents - paidCents;
  return {
    balanceDue: due,
    status: due <= 0 ? "paid" : paidCents > 0 ? "partial" : "open",
  };
}
