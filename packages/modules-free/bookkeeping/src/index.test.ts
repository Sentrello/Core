import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import bookkeeping from "./index";

const suffix = crypto.randomUUID().slice(0, 8);
const email = `bookkeeping-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;

beforeAll(async () => {
  bookkeeping.register({
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
    body: { name: `Bookkeeping ${suffix}`, slug: `bookkeeping-${suffix}` },
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
  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  const entryIds = entries.map((e) => e.id);
  if (entryIds.length > 0) {
    await db
      .delete(schema.journalLines)
      .where(inArray(schema.journalLines.entryId, entryIds));
  }
  for (const [table, column] of [
    [schema.journalEntries, schema.journalEntries.organizationId],
    [schema.expenses, schema.expenses.organizationId],
    [schema.accounts, schema.accounts.organizationId],
  ] as const) {
    await db.delete(table).where(eq(column, orgId));
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

const post = (path: string, body: unknown) =>
  app.request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

const pnl = async () => {
  const res = await app.request(
    "http://localhost/api/reports/profit-and-loss",
    { headers },
  );
  return (await res.json()) as {
    incomeCents: number;
    expenseCents: number;
    netCents: number;
  };
};

test("an expense reaches the profit and loss", async () => {
  // The report is read from the ledger, so an expense that is only a row in a
  // table is an expense the business never sees.
  const before = await pnl();

  const res = await post("/api/expenses", {
    vendor: "Ink Co",
    amountCents: 4599,
  });
  expect(res.status).toBe(201);

  const after = await pnl();
  expect(after.expenseCents).toBe(before.expenseCents + 4599);
  expect(after.netCents).toBe(before.netCents - 4599);
});

test("the entry it posts is balanced, and hits cash", async () => {
  await post("/api/expenses", { vendor: "Fuel", amountCents: 3000 });

  const rows = await db
    .select({
      debitCents: schema.journalLines.debitCents,
      creditCents: schema.journalLines.creditCents,
      code: schema.accounts.code,
      source: schema.journalEntries.source,
    })
    .from(schema.journalLines)
    .innerJoin(
      schema.journalEntries,
      eq(schema.journalLines.entryId, schema.journalEntries.id),
    )
    .innerJoin(
      schema.accounts,
      eq(schema.journalLines.accountId, schema.accounts.id),
    )
    .where(eq(schema.journalEntries.organizationId, orgId));

  const fuel = rows.filter(
    (r) => r.debitCents === 3000 || r.creditCents === 3000,
  );
  expect(fuel.some((r) => r.code === "6000" && r.debitCents === 3000)).toBe(
    true,
  );
  expect(fuel.some((r) => r.code === "1000" && r.creditCents === 3000)).toBe(
    true,
  );

  const debits = rows.reduce((s, r) => s + r.debitCents, 0);
  const credits = rows.reduce((s, r) => s + r.creditCents, 0);
  expect(debits).toBe(credits);
});

test("an expense posts to the account it was given", async () => {
  const created = await post("/api/accounts", {
    code: "6200",
    name: "Software",
    type: "expense",
  });
  const { account } = (await created.json()) as { account: { id: string } };

  await post("/api/expenses", {
    vendor: "Some SaaS",
    amountCents: 1200,
    accountId: account.id,
  });

  const [line] = await db
    .select({ debitCents: schema.journalLines.debitCents })
    .from(schema.journalLines)
    .where(eq(schema.journalLines.accountId, account.id));
  expect(line?.debitCents).toBe(1200);
});

test("an account belonging to someone else is refused", async () => {
  // The id comes from the caller, so it is the obvious way to try to write
  // into another tenant's ledger.
  const [foreign] = await db
    .insert(schema.accounts)
    .values({
      organizationId: `org_other_${suffix}`,
      code: "6300",
      name: "Not yours",
      type: "expense",
    })
    .returning();

  const res = await post("/api/expenses", {
    vendor: "Nice try",
    amountCents: 500,
    accountId: foreign?.id,
  });
  expect(res.status).toBe(400);

  const lines = await db
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.accountId, foreign?.id ?? ""));
  expect(lines).toHaveLength(0);

  await db
    .delete(schema.accounts)
    .where(eq(schema.accounts.id, foreign?.id ?? ""));
});

test("an amount that is not integer cents is refused", async () => {
  const res = await post("/api/expenses", {
    vendor: "Rounding",
    amountCents: 12.5,
  });
  expect(res.status).toBe(400);
});
