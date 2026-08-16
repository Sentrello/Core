import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import crm, { displayName } from "./index";

const suffix = crypto.randomUUID().slice(0, 8);
const email = `crm-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;

beforeAll(async () => {
  crm.register({
    app,
    entitled: () => true,
    registerNav: () => {},
    registerPermission: () => {},
    registerJob: () => {},
  });

  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `CRM ${suffix}`, slug: `crm-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });
});

afterAll(async () => {
  await db
    .delete(schema.contacts)
    .where(eq(schema.contacts.organizationId, orgId));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (u) {
    await db.delete(schema.session).where(eq(schema.session.userId, u.id));
    await db.delete(schema.account).where(eq(schema.account.userId, u.id));
    await db.delete(schema.user).where(eq(schema.user.id, u.id));
  }
});

test("create returns the row under a singular key and scopes it to the org", async () => {
  const res = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Acme Ltd", email: "ap@acme.test" }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    contact: { id: string; organizationId: string };
  };
  expect(body.contact.organizationId).toBe(orgId);
});

test("list returns rows under a plural key", async () => {
  const res = await app.request("http://localhost/api/contacts", { headers });
  const body = (await res.json()) as { contacts: { name: string }[] };
  expect(body.contacts.map((c) => c.name)).toContain("Acme Ltd");
});

test("a row belonging to another organization is invisible and unpatchable", async () => {
  const [foreign] = await db
    .insert(schema.contacts)
    .values({ organizationId: `other-org-${suffix}`, name: "Not Yours" })
    .returning();
  if (!foreign) throw new Error("could not create foreign contact");

  const list = await app.request("http://localhost/api/contacts", { headers });
  const body = (await list.json()) as { contacts: { id: string }[] };
  expect(body.contacts.some((c) => c.id === foreign.id)).toBe(false);

  const patch = await app.request(
    `http://localhost/api/contacts/${foreign.id}`,
    { method: "PATCH", headers, body: JSON.stringify({ name: "Hijacked" }) },
  );
  expect(patch.status).toBe(404);

  const [after] = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, foreign.id));
  expect(after?.name).toBe("Not Yours");

  await db.delete(schema.contacts).where(eq(schema.contacts.id, foreign.id));
});

test("a patch cannot move a row into another organization", async () => {
  const created = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Movable" }),
  });
  const { contact } = (await created.json()) as { contact: { id: string } };

  const res = await app.request(`http://localhost/api/contacts/${contact.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ name: "Moved", organizationId: "somewhere-else" }),
  });
  expect(res.status).toBe(200);

  const [after] = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, contact.id));
  expect(after?.organizationId).toBe(orgId);
  expect(after?.name).toBe("Moved");
});

test("delete removes only this organization's row", async () => {
  const created = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Temporary" }),
  });
  const { contact } = (await created.json()) as { contact: { id: string } };

  const res = await app.request(`http://localhost/api/contacts/${contact.id}`, {
    method: "DELETE",
    headers,
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ deleted: contact.id });

  const again = await app.request(
    `http://localhost/api/contacts/${contact.id}`,
    { method: "DELETE", headers },
  );
  expect(again.status).toBe(404);
});

test("a customer with invoices cannot be deleted", async () => {
  // Nothing is protected by a foreign key, so the delete would succeed and
  // leave the invoice naming nobody while the ledger still holds the money.
  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Has history" })
    .returning();
  await db.insert(schema.invoices).values({
    organizationId: orgId,
    contactId: contact?.id,
    number: `INV-GUARD-${suffix}`,
    status: "open",
    currency: "USD",
    subtotalCents: 1000,
    taxCents: 0,
    totalCents: 1000,
  });

  const res = await app.request(
    `http://localhost/api/contacts/${contact?.id}`,
    { method: "DELETE", headers },
  );
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("1 invoice");

  const [still] = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, contact?.id ?? ""));
  expect(still).toBeDefined();

  await db
    .delete(schema.invoices)
    .where(eq(schema.invoices.contactId, contact?.id ?? ""));
  await db
    .delete(schema.contacts)
    .where(eq(schema.contacts.id, contact?.id ?? ""));
});

test("a customer with no history deletes cleanly", async () => {
  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Mistyped entry" })
    .returning();

  const res = await app.request(
    `http://localhost/api/contacts/${contact?.id}`,
    { method: "DELETE", headers },
  );
  expect(res.status).toBe(200);

  const rows = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, contact?.id ?? ""));
  expect(rows).toHaveLength(0);
});

/**
 * JSON has no date type, so a client can only send a string — and the column
 * is a timestamp. Drizzle handed the string to the driver, which called
 * `.toISOString()` on it and threw, so every client that sent a date got a 500
 * and no indication why.
 */
test("a date sent as a string is accepted, because that is the only way to send one", async () => {
  const contact = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Date Test" }),
  });
  const { contact: c } = (await contact.json()) as { contact: { id: string } };

  const res = await app.request("http://localhost/api/activities", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId: c.id,
      type: "note",
      body: "Called about the gutters",
      occurredAt: "2026-08-13T09:30:00.000Z",
    }),
  });
  expect(res.status).toBe(201);

  const { activity } = (await res.json()) as {
    activity: { occurredAt: string };
  };
  expect(new Date(activity.occurredAt).toISOString()).toBe(
    "2026-08-13T09:30:00.000Z",
  );
});

test("a date that is not a date is refused, not a 500", async () => {
  const res = await app.request("http://localhost/api/tasks", {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Bad date", dueAt: "next Tuesday-ish" }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("dueAt");
});

test("an omitted date is still omitted", async () => {
  const res = await app.request("http://localhost/api/tasks", {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "No due date" }),
  });
  expect(res.status).toBe(201);
});

/**
 * The display name is written, not computed.
 *
 * Invoices, quotes and the customer portal select `name` directly, so an
 * invoice addressed to nobody because somebody edited a surname would surface
 * far from the CRM that caused it.
 */
test("a contact's display name follows its first and last name", () => {
  expect(displayName({ firstName: "Ada", lastName: "Lovelace" })).toBe(
    "Ada Lovelace",
  );
  expect(displayName({ firstName: "  Ada  ", lastName: "" })).toBe("Ada");
});

test("an edit that never mentions a name does not wipe it", () => {
  // Most existing contacts are a single string with no first or last name at
  // all; a PATCH changing a phone number must leave that alone.
  expect(displayName({ name: "Redwood Handyman Co." })).toBe(
    "Redwood Handyman Co.",
  );
  expect(displayName({ phone: "0117 496 0000" })).toBeUndefined();
});

/**
 * Moving a card on the kanban. Stage and position travel together because
 * dragging is one action — two calls would leave a card that changed column
 * but not order if the second failed.
 */
test("a deal moves column and position in one call", async () => {
  const created = await app.request("http://localhost/api/deals", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Roof repair", amountCents: 120_000 }),
  });
  expect(created.status).toBe(201);
  const { deal } = (await created.json()) as { deal: { id: string } };

  const moved = await app.request(
    `http://localhost/api/deals/${deal.id}/move`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ stage: "won", position: 2 }),
    },
  );
  expect(moved.status).toBe(200);
  const body = (await moved.json()) as {
    deal: { stage: string; position: number };
  };
  expect(body.deal.stage).toBe("won");
  expect(body.deal.position).toBe(2);
});

test("a move that says nothing is refused rather than silently doing nothing", async () => {
  const created = await app.request("http://localhost/api/deals", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Gutter clean" }),
  });
  const { deal } = (await created.json()) as { deal: { id: string } };

  const res = await app.request(`http://localhost/api/deals/${deal.id}/move`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(400);
});

/**
 * A contact that cannot show what it is attached to is a row in a table. This
 * endpoint is what the UI reads to stop the application looking like unrelated
 * parts.
 */
test("a contact comes back with everything it connects to", async () => {
  const madeContact = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ firstName: "Ada", lastName: "Lovelace" }),
  });
  const { contact } = (await madeContact.json()) as {
    contact: { id: string; name: string };
  };
  expect(contact.name).toBe("Ada Lovelace");

  await app.request("http://localhost/api/notes", {
    method: "POST",
    headers,
    body: JSON.stringify({
      entityType: "contact",
      entityId: contact.id,
      text: "Wants a quote for the roof",
    }),
  });
  await app.request("http://localhost/api/deals", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Roof", contactIds: [contact.id] }),
  });

  const res = await app.request(
    `http://localhost/api/contacts/${contact.id}/related`,
    { headers },
  );
  expect(res.status).toBe(200);
  const related = (await res.json()) as {
    notes: unknown[];
    deals: { name: string }[];
  };
  expect(related.notes).toHaveLength(1);
  expect(related.deals.map((d) => d.name)).toEqual(["Roof"]);
});

test("another organisation's contact is not found", async () => {
  // The org filter is the tenant boundary; a related-records endpoint that
  // spans five tables is exactly where forgetting it would leak most.
  const res = await app.request(
    "http://localhost/api/contacts/00000000-0000-0000-0000-000000000000/related",
    { headers },
  );
  expect(res.status).toBe(404);
});
