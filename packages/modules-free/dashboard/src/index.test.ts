import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import { eq } from "drizzle-orm";
import dashboard from "./index";

const app = registerForTest(dashboard);
let headers: Headers;
let orgId: string;

const suffix = crypto.randomUUID().slice(0, 8);

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `dash-${suffix}@x.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Dash ${suffix}`, slug: `dash-${suffix}` },
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
  // The owner has to go too. Leaving one behind makes the instance look
  // claimed, and every bootstrap test then fails on a database this one
  // dirtied — which reads as those tests breaking, not this one.
  await db
    .delete(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));
  await db.delete(schema.tasks).where(eq(schema.tasks.organizationId, orgId));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));

  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, `dash-${suffix}@x.test`));
  if (u) {
    await db.delete(schema.session).where(eq(schema.session.userId, u.id));
    await db.delete(schema.account).where(eq(schema.account.userId, u.id));
    await db.delete(schema.user).where(eq(schema.user.id, u.id));
  }
});

const get = () => app.request("http://localhost/api/dashboard", { headers });

test("an empty instance reports zeroes rather than failing", async () => {
  // A brand new Free instance is the first thing anyone sees. A dashboard that
  // needs data to render is a broken first impression.
  const res = await get();
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    money: { owedCents: number };
    attention: unknown[];
  };
  expect(body.money.owedCents).toBe(0);
  expect(body.attention).toEqual([]);
});

/**
 * Owed and overdue are two numbers on purpose. "You are owed 8,000" and "6,000
 * of it is late" call for completely different afternoons.
 */
test("overdue is counted apart from merely unpaid", async () => {
  const yesterday = new Date(Date.now() - 86_400_000);
  const nextMonth = new Date(Date.now() + 30 * 86_400_000);

  await db.insert(schema.invoices).values([
    {
      organizationId: orgId,
      number: "INV-100",
      status: "sent",
      currency: "USD",
      issueDate: yesterday,
      dueDate: yesterday,
      subtotalCents: 60_000,
      taxCents: 0,
      totalCents: 60_000,
    },
    {
      organizationId: orgId,
      number: "INV-101",
      status: "sent",
      currency: "USD",
      issueDate: new Date(),
      dueDate: nextMonth,
      subtotalCents: 20_000,
      taxCents: 0,
      totalCents: 20_000,
    },
    // Paid invoices are neither owed nor overdue; counting them would make the
    // headline number grow for ever.
    {
      organizationId: orgId,
      number: "INV-102",
      status: "paid",
      currency: "USD",
      issueDate: yesterday,
      dueDate: yesterday,
      subtotalCents: 99_000,
      taxCents: 0,
      totalCents: 99_000,
    },
  ]);

  const body = (await (await get()).json()) as {
    money: {
      owedCents: number;
      overdueCents: number;
      unpaidCount: number;
      overdueCount: number;
    };
    attention: { kind: string; summary: string }[];
  };

  expect(body.money.owedCents).toBe(80_000);
  expect(body.money.overdueCents).toBe(60_000);
  expect(body.money.unpaidCount).toBe(2);
  expect(body.money.overdueCount).toBe(1);
  expect(body.attention.some((a) => a.summary.includes("INV-100"))).toBe(true);
  expect(body.attention.some((a) => a.summary.includes("INV-101"))).toBe(false);
});

test("a follow-up that was due yesterday needs attention", async () => {
  await db.insert(schema.tasks).values({
    organizationId: orgId,
    title: "Chase the Brixton quote",
    dueAt: new Date(Date.now() - 86_400_000),
    done: false,
  });
  const body = (await (await get()).json()) as {
    attention: { kind: string; summary: string }[];
  };
  expect(
    body.attention.some(
      (a) => a.kind === "task" && a.summary === "Chase the Brixton quote",
    ),
  ).toBe(true);
});

test("a completed follow-up is not still asking to be done", async () => {
  await db.insert(schema.tasks).values({
    organizationId: orgId,
    title: "Already handled",
    dueAt: new Date(Date.now() - 86_400_000),
    done: true,
  });
  const body = (await (await get()).json()) as {
    attention: { summary: string }[];
  };
  expect(body.attention.some((a) => a.summary === "Already handled")).toBe(
    false,
  );
});
