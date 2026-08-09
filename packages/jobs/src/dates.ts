export type Interval = "monthly" | "yearly";

export function nextRun(from: Date, interval: Interval): Date {
  const d = new Date(from);
  const day = d.getUTCDate();
  if (interval === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  if (d.getUTCDate() < day) d.setUTCDate(0); // clamp Jan 31 + 1mo -> Feb 28/29
  return d;
}

export function isOverdue(
  dueDate: Date,
  balanceDueCents: number,
  now = new Date(),
): boolean {
  return balanceDueCents > 0 && dueDate.getTime() < now.getTime();
}
