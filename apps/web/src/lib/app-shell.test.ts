import { expect, test } from "bun:test";

/**
 * Sidebar sections. Mirrors `sections()` in app-shell.tsx — the grouping rules
 * are the thing worth checking, not the markup around them.
 */
interface N {
  id: string;
  label: string;
  group?: string;
}
const GROUP_ORDER = ["Sales", "Money", "Work", "People", "Configure"];

function sections(nav: N[]) {
  const byGroup = new Map<string, N[]>();
  for (const item of nav) {
    const key = item.group ?? "";
    const list = byGroup.get(key);
    if (list) list.push(item);
    else byGroup.set(key, [item]);
  }
  return [...byGroup.entries()]
    .map(([name, items]) => ({ name, items }))
    .sort((a, b) => {
      const ai = GROUP_ORDER.indexOf(a.name);
      const bi = GROUP_ORDER.indexOf(b.name);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
}

test("sections follow the order work happens in, not the alphabet", () => {
  const out = sections([
    { id: "settings", label: "Settings", group: "Configure" },
    { id: "invoicing", label: "Invoices", group: "Money" },
    { id: "crm", label: "Contacts", group: "Sales" },
    { id: "projects", label: "Projects", group: "Work" },
  ]);
  expect(out.map((s) => s.name)).toEqual([
    "Sales",
    "Money",
    "Work",
    "Configure",
  ]);
});

test("the chain a business follows lands in one section", () => {
  // Contact, quote and deal are the same piece of work; a flat list said
  // nothing about that, which was the complaint.
  const out = sections([
    { id: "crm", label: "Contacts", group: "Sales" },
    { id: "quotes", label: "Quotes", group: "Sales" },
    { id: "deals", label: "Deals", group: "Sales" },
    { id: "bookkeeping", label: "Bookkeeping", group: "Money" },
  ]);
  const sales = out.find((s) => s.name === "Sales");
  expect(sales?.items.map((i) => i.label)).toEqual([
    "Contacts",
    "Quotes",
    "Deals",
  ]);
});

/**
 * A module may name a section the host has never heard of. Dropping it would
 * make the module's screens unreachable, which is worse than an odd heading.
 */
test("an unknown section is kept, at the end", () => {
  const out = sections([
    { id: "crm", label: "Contacts", group: "Sales" },
    { id: "x", label: "Something New", group: "Logistics" },
  ]);
  expect(out.map((s) => s.name)).toEqual(["Sales", "Logistics"]);
});

test("an entry with no section is still reachable", () => {
  const out = sections([{ id: "loose", label: "Loose" }]);
  expect(out[0]?.name).toBe("");
  expect(out[0]?.items).toHaveLength(1);
});
