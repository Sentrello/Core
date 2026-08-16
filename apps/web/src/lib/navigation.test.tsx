import { expect, test } from "bun:test";

/**
 * The trail is what lets a screen offer the way back, so its bookkeeping is
 * worth checking directly. Exercised as a reducer rather than through React:
 * the rules are the thing that matters, not the rendering.
 */
interface V {
  moduleId: string;
  recordId?: string;
  title: string;
}

/** Mirrors NavigationProvider.open — see the comment there for the why. */
function open(trail: V[], current: V, next: V): { trail: V[]; current: V } {
  const seen = trail.findIndex(
    (v) => v.moduleId === next.moduleId && v.recordId === next.recordId,
  );
  return seen !== -1
    ? { trail: trail.slice(0, seen), current: next }
    : { trail: [...trail, current], current: next };
}

const contact: V = { moduleId: "crm", recordId: "c1", title: "Acme Ltd" };
const deal: V = { moduleId: "deals", recordId: "d1", title: "Roof repair" };
const invoice: V = { moduleId: "invoicing", recordId: "i1", title: "INV-004" };

test("following a chain remembers how you got there", () => {
  let s = { trail: [] as V[], current: { moduleId: "crm", title: "Contacts" } };
  s = open(s.trail, s.current, contact);
  s = open(s.trail, s.current, deal);
  s = open(s.trail, s.current, invoice);

  expect(s.current.title).toBe("INV-004");
  expect(s.trail.map((v) => v.title)).toEqual([
    "Contacts",
    "Acme Ltd",
    "Roof repair",
  ]);
});

/**
 * A contact leads to a deal which links back to the same contact. Treating that
 * as going deeper would grow the trail for ever and make the breadcrumb claim a
 * journey nobody took.
 */
test("going back to something already behind you shortens the trail", () => {
  let s = { trail: [] as V[], current: { moduleId: "crm", title: "Contacts" } };
  s = open(s.trail, s.current, contact);
  s = open(s.trail, s.current, deal);
  s = open(s.trail, s.current, contact);

  expect(s.current.title).toBe("Acme Ltd");
  expect(s.trail.map((v) => v.title)).toEqual(["Contacts"]);
});

test("two records in the same module are different places", () => {
  // Same moduleId, different record — going from one deal to another is
  // forward, not back.
  const other: V = { moduleId: "deals", recordId: "d2", title: "Gutter clean" };
  let s = { trail: [] as V[], current: { moduleId: "deals", title: "Deals" } };
  s = open(s.trail, s.current, deal);
  s = open(s.trail, s.current, other);

  expect(s.trail.map((v) => v.title)).toEqual(["Deals", "Roof repair"]);
});
