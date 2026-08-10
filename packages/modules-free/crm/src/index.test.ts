import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import crm from "./index";

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
