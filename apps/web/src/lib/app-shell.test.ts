import { expect, test } from "bun:test";
import { type NavEntry, sections } from "./app-shell";

/**
 * Sidebar sections — the real function, not a copy of it.
 *
 * This file used to restate the sorting rules rather than import them, and
 * the copy stayed green while the sidebar put the Dashboard underneath every
 * other section. A test that mirrors the code proves only that somebody wrote
 * the same thing twice.
 */
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

/**
 * The first screen anybody sees, in the first place they look.
 *
 * The Dashboard belongs to no section, and "no section" sorted with "a
 * section nobody recognises" — so it landed at the bottom of the sidebar,
 * under Configure.
 */
test("an entry with no section sits above the sections", () => {
  const out = sections([
    {
      id: "settings",
      label: "Settings",
      group: "Configure",
      moduleId: "settings",
    },
    { id: "crm", label: "Contacts", group: "Sales", moduleId: "crm" },
    { id: "dashboard", label: "Dashboard", group: "", moduleId: "dashboard" },
  ]);
  expect(out[0]?.name).toBe("");
  expect(out[0]?.items.map((i) => i.label)).toEqual(["Dashboard"]);
  expect(out.map((s) => s.name)).toEqual(["", "Sales", "Configure"]);
});

test("an unrecognised section still goes last, below the known ones", () => {
  const out = sections([
    { id: "x", label: "Something New", group: "Logistics", moduleId: "x" },
    { id: "dashboard", label: "Dashboard", moduleId: "dashboard" },
    { id: "crm", label: "Contacts", group: "Sales", moduleId: "crm" },
  ]);
  expect(out.map((s) => s.name)).toEqual(["", "Sales", "Logistics"]);
});
