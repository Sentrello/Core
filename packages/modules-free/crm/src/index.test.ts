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

test("a deal is created with the fields the caller sent", async () => {
  // The demo seed hit a 500 here: every column inserted as its default, so the
  // NOT NULL name failed. Worth pinning the whole body rather than one field.
  const res = await app.request("http://localhost/api/deals", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Cellar damp works",
      companyId: null,
      contactIds: [],
      stage: "proposal",
      amountCents: 220_000,
      category: "Repair",
      position: 0,
    }),
  });
  expect(res.status).toBe(201);
  const { deal } = (await res.json()) as {
    deal: { name: string; stage: string; amountCents: number };
  };
  expect(deal.name).toBe("Cellar damp works");
  expect(deal.stage).toBe("proposal");
  expect(deal.amountCents).toBe(220_000);
});

/**
 * The far side of the link on a contact. A company name that opened a list of
 * every company would look like a connection and behave like a dead end.
 */
test("a company comes back with its people and its deals", async () => {
  const madeCo = await app.request("http://localhost/api/companies", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Ellesmere Dental", sector: "Healthcare" }),
  });
  const { company } = (await madeCo.json()) as { company: { id: string } };

  await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      firstName: "Sunniva",
      lastName: "Restrepo",
      companyId: company.id,
    }),
  });
  await app.request("http://localhost/api/deals", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Surgery 3 fit-out",
      companyId: company.id,
      amountCents: 1_150_000,
    }),
  });

  const res = await app.request(
    `http://localhost/api/companies/${company.id}/related`,
    { headers },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    contacts: { name: string }[];
    deals: { name: string }[];
  };
  expect(body.contacts.map((p) => p.name)).toEqual(["Sunniva Restrepo"]);
  expect(body.deals.map((d) => d.name)).toEqual(["Surgery 3 fit-out"]);
});

/**
 * Tags. `taggables` has no organizationId of its own — it is scoped through
 * the tag it points at, so these routes are the only thing standing between a
 * guessed id and labelling another business's records.
 */
test("a tag can be put on a contact and taken off again", async () => {
  const madeTag = await app.request("http://localhost/api/tags", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Repeat customer", color: "#22c55e" }),
  });
  const { tag } = (await madeTag.json()) as { tag: { id: string } };

  const madeContact = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ firstName: "Vernon", lastName: "Achebe" }),
  });
  const { contact } = (await madeContact.json()) as {
    contact: { id: string };
  };

  const attached = await app.request(
    `http://localhost/api/contacts/${contact.id}/tags`,
    { method: "POST", headers, body: JSON.stringify({ tagId: tag.id }) },
  );
  expect(attached.status).toBe(201);

  let related = (await (
    await app.request(`http://localhost/api/contacts/${contact.id}/related`, {
      headers,
    })
  ).json()) as { tags: { id: string }[] };
  expect(related.tags.map((t) => t.id)).toEqual([tag.id]);

  const removed = await app.request(
    `http://localhost/api/contacts/${contact.id}/tags/${tag.id}`,
    { method: "DELETE", headers },
  );
  expect(removed.status).toBe(204);

  related = (await (
    await app.request(`http://localhost/api/contacts/${contact.id}/related`, {
      headers,
    })
  ).json()) as { tags: { id: string }[] };
  expect(related.tags).toHaveLength(0);
});

test("tagging twice does not label the record twice", async () => {
  // Somebody clicks twice. A duplicate row would show the same label on the
  // record two times over.
  const madeTag = await app.request("http://localhost/api/tags", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Urgent" }),
  });
  const { tag } = (await madeTag.json()) as { tag: { id: string } };
  const madeContact = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ firstName: "Twice", lastName: "Clicked" }),
  });
  const { contact } = (await madeContact.json()) as { contact: { id: string } };

  for (let i = 0; i < 2; i += 1) {
    await app.request(`http://localhost/api/contacts/${contact.id}/tags`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tagId: tag.id }),
    });
  }

  const related = (await (
    await app.request(`http://localhost/api/contacts/${contact.id}/related`, {
      headers,
    })
  ).json()) as { tags: unknown[] };
  expect(related.tags).toHaveLength(1);
});

test("a tag that is not this organisation's cannot be attached", async () => {
  const madeContact = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ firstName: "Someone", lastName: "Else" }),
  });
  const { contact } = (await madeContact.json()) as { contact: { id: string } };

  const res = await app.request(
    `http://localhost/api/contacts/${contact.id}/tags`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        tagId: "00000000-0000-0000-0000-000000000000",
      }),
    },
  );
  expect(res.status).toBe(404);
});

/**
 * The board links to a deal, so this endpoint is what stops every card being a
 * dead end — the same failure a contact's company link had before companies
 * got a screen.
 */
test("a deal comes back with its company and the people on it", async () => {
  const madeCo = await app.request("http://localhost/api/companies", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "The Brixton Tap" }),
  });
  const { company } = (await madeCo.json()) as { company: { id: string } };

  const madePerson = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ firstName: "Dermot", lastName: "Kavanagh" }),
  });
  const { contact } = (await madePerson.json()) as { contact: { id: string } };

  const madeDeal = await app.request("http://localhost/api/deals", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Cellar damp works",
      companyId: company.id,
      contactIds: [contact.id],
      amountCents: 220_000,
    }),
  });
  const { deal } = (await madeDeal.json()) as { deal: { id: string } };

  const res = await app.request(
    `http://localhost/api/deals/${deal.id}/related`,
    { headers },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    company: { name: string } | null;
    contacts: { name: string }[];
  };
  expect(body.company?.name).toBe("The Brixton Tap");
  expect(body.contacts.map((p) => p.name)).toEqual(["Dermot Kavanagh"]);
});

test("a deal only returns the contacts actually on it", async () => {
  // Contacts are gathered in memory from a jsonb array, so the filter is the
  // thing doing the work — get it wrong and every contact appears on every
  // deal.
  await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ firstName: "Not", lastName: "Involved" }),
  });
  const madeDeal = await app.request("http://localhost/api/deals", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Nobody's deal", contactIds: [] }),
  });
  const { deal } = (await madeDeal.json()) as { deal: { id: string } };

  const res = await app.request(
    `http://localhost/api/deals/${deal.id}/related`,
    { headers },
  );
  const body = (await res.json()) as { contacts: unknown[] };
  expect(body.contacts).toHaveLength(0);
});

/**
 * Editing has to be able to clear a field as well as set one. An empty string
 * where a null belongs leaves "" in the database, which reads back as a value
 * and prints as a blank line on an invoice.
 */
test("a contact's details can be corrected, including cleared", async () => {
  const made = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      firstName: "Marguerite",
      lastName: "Osei",
      title: "Owner",
      phone: "503 555 0142",
    }),
  });
  const { contact } = (await made.json()) as { contact: { id: string } };

  const res = await app.request(`http://localhost/api/contacts/${contact.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      firstName: "Marguerite",
      lastName: "Osei-Bonsu",
      title: null,
      phones: [{ label: "mobile", value: "503 555 0187" }],
    }),
  });
  expect(res.status).toBe(200);

  const body = (await res.json()) as {
    contact: {
      name: string;
      title: string | null;
      phones: { value: string }[] | null;
    };
  };
  // The display name follows the surname change, because invoices read it.
  expect(body.contact.name).toBe("Marguerite Osei-Bonsu");
  expect(body.contact.title).toBeNull();
  expect(body.contact.phones?.[0]?.value).toBe("503 555 0187");
});

test("a company can be corrected after it is created", async () => {
  const made = await app.request("http://localhost/api/companies", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Brixton Tap" }),
  });
  const { company } = (await made.json()) as { company: { id: string } };

  const res = await app.request(
    `http://localhost/api/companies/${company.id}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "The Brixton Tap", size: 12, sector: null }),
    },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    company: { name: string; size: number | null; sector: string | null };
  };
  expect(body.company.name).toBe("The Brixton Tap");
  expect(body.company.size).toBe(12);
  expect(body.company.sector).toBeNull();
});
