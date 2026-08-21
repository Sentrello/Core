import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { Hono } from "hono";
import crm from "./index";

const suffix = crypto.randomUUID().slice(0, 8);
const email = `crm-dash-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;

const days = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

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
    body: { name: `CRM dash ${suffix}`, slug: `crm-dash-${suffix}` },
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
  for (const table of [
    schema.activities,
    schema.tasks,
    schema.deals,
    schema.contacts,
  ]) {
    await db.delete(table).where(eq(table.organizationId, orgId));
  }
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

const dashboard = async () => {
  const res = await app.request("http://localhost/api/crm/dashboard", {
    headers,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    hotContacts: { id: string; name: string }[];
    upcomingRevenue: {
      totalCents: number;
      deals: { id: string; name: string }[];
      overdue: { count: number; totalCents: number };
    };
    latestActivity: { id: string; type: string }[];
    tasks: { id: string; title: string; overdue: boolean }[];
    goingCold: number;
  };
};

test("it ranks contacts by what is actually happening, not the alphabet", async () => {
  const [quiet] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Aaron Quiet" })
    .returning();
  const [busy] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Zoe Busy" })
    .returning();

  await db.insert(schema.activities).values({
    organizationId: orgId,
    contactId: busy?.id,
    type: "call",
    body: "talked through the quote",
    occurredAt: days(-1),
  });

  const body = await dashboard();
  expect(body.hotContacts[0]?.name).toBe("Zoe Busy");
  // Somebody nobody has ever spoken to is not hot. A list that opens with
  // them is a list people learn to ignore.
  expect(body.hotContacts.map((c) => c.id)).not.toContain(quiet?.id);
});

/**
 * Upcoming revenue is what says it will land inside the horizon — not a
 * probability-weighted forecast, which is a number nobody can check.
 */
test("upcoming revenue counts what closes soon, and nothing else", async () => {
  await db.insert(schema.deals).values([
    {
      organizationId: orgId,
      name: "Closing this month",
      amountCents: 250_000,
      expectedCloseOn: days(10).toISOString().slice(0, 10),
    },
    {
      organizationId: orgId,
      name: "Next quarter",
      amountCents: 900_000,
      expectedCloseOn: days(120).toISOString().slice(0, 10),
    },
    {
      organizationId: orgId,
      name: "No date yet",
      amountCents: 400_000,
    },
  ]);

  const body = await dashboard();
  expect(body.upcomingRevenue.totalCents).toBe(250_000);
  expect(body.upcomingRevenue.deals.map((d) => d.name)).toEqual([
    "Closing this month",
  ]);
});

/**
 * A deal whose close date has passed is not upcoming revenue — it is a
 * conversation somebody has been avoiding. Adding it to the forecast hides the
 * one thing on this screen worth acting on.
 */
test("an overdue deal is counted separately, never in the forecast", async () => {
  await db.insert(schema.deals).values({
    organizationId: orgId,
    name: "Should have closed",
    amountCents: 700_000,
    expectedCloseOn: days(-14).toISOString().slice(0, 10),
  });

  const body = await dashboard();
  expect(body.upcomingRevenue.totalCents).toBe(250_000);
  expect(body.upcomingRevenue.overdue.count).toBe(1);
  expect(body.upcomingRevenue.overdue.totalCents).toBe(700_000);
});

test("tasks come back soonest first, and say which are late", async () => {
  await db.insert(schema.tasks).values([
    { organizationId: orgId, title: "Ring back Tuesday", dueAt: days(2) },
    { organizationId: orgId, title: "Chase the survey", dueAt: days(-3) },
    {
      organizationId: orgId,
      title: "Already done",
      dueAt: days(1),
      done: true,
    },
  ]);

  const body = await dashboard();
  expect(body.tasks[0]?.title).toBe("Chase the survey");
  expect(body.tasks[0]?.overdue).toBe(true);
  // A finished task is not something to do.
  expect(body.tasks.map((t) => t.title)).not.toContain("Already done");
});

test("another organization's CRM never appears on this one's dashboard", async () => {
  const theirs = `other-${crypto.randomUUID().slice(0, 8)}`;
  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: theirs, name: "Their Secret Contact" })
    .returning();
  await db.insert(schema.activities).values({
    organizationId: theirs,
    contactId: contact?.id,
    type: "call",
    body: "Their Secret Call",
  });
  await db.insert(schema.deals).values({
    organizationId: theirs,
    name: "Their Secret Deal",
    amountCents: 5_000_000,
    expectedCloseOn: days(5).toISOString().slice(0, 10),
  });

  const res = await app.request("http://localhost/api/crm/dashboard", {
    headers,
  });
  const text = await res.text();
  expect(text).not.toContain("Their Secret");
  expect(JSON.parse(text).upcomingRevenue.totalCents).toBe(250_000);

  for (const table of [schema.activities, schema.deals, schema.contacts]) {
    await db.delete(table).where(eq(table.organizationId, theirs));
  }
});
