export type TaxedLine = {
  quantity: number;
  unitPrice: number;
  taxRateBp: number;
};

export function lineTotals(lines: TaxedLine[]) {
  let subtotal = 0;
  let tax = 0;
  for (const l of lines) {
    const net = l.quantity * l.unitPrice;
    subtotal += net;
    tax += Math.round((net * l.taxRateBp) / 10000);
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
