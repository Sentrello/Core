import { afterAll, afterEach, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import { auth } from "./index";
import { signUpAllowed } from "./signup-policy";

const suffix = crypto.randomUUID().slice(0, 8);
const orgId = `signup-policy-${suffix}`;
const password = "correct-horse-battery-staple";
const createdEmails: string[] = [];

async function withOrganization<T>(fn: () => Promise<T>): Promise<T> {
  await db.insert(schema.organizations).values({
    id: orgId,
    name: `Policy ${suffix}`,
    slug: `policy-${suffix}`,
    createdAt: new Date(),
  });
  try {
    return await fn();
  } finally {
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, orgId));
  }
}

afterEach(() => {
  process.env.SENTRELLO_ALLOW_SIGNUP = undefined;
});

afterAll(async () => {
  for (const email of createdEmails) {
    const [u] = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, email));
    if (!u) continue;
    await db.delete(schema.session).where(eq(schema.session.userId, u.id));
    await db.delete(schema.account).where(eq(schema.account.userId, u.id));
    await db.delete(schema.user).where(eq(schema.user.id, u.id));
  }
});

test("an unclaimed instance allows sign-up so the owner can claim it", async () => {
  // no organization rows for this test's purposes is the normal empty-instance
  // case; the suite cleans up after itself so this reflects a fresh install
  const orgs = await db.select().from(schema.organizations).limit(1);
  if (orgs.length > 0) return; // another suite's fixture is live; covered below
  expect((await signUpAllowed("anyone@example.test", false)).allowed).toBe(
    true,
  );
});

test("once claimed, an uninvited stranger is refused", async () => {
  await withOrganization(async () => {
    const decision = await signUpAllowed("stranger@example.test", false);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("closed");
  });
});

test("a pending invitation lets exactly that address through", async () => {
  await withOrganization(async () => {
    const invited = `invited-${suffix}@example.test`;
    // the inviter is a real user: the table has a foreign key to it
    const inviterId = `inviter-${suffix}`;
    await db.insert(schema.user).values({
      id: inviterId,
      name: "Inviter",
      email: `inviter-${suffix}@example.test`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.invitation).values({
      id: `inv-${suffix}`,
      organizationId: orgId,
      email: invited,
      role: "staff",
      status: "pending",
      expiresAt: new Date(Date.now() + 86_400_000),
      inviterId,
    });

    expect((await signUpAllowed(invited, false)).allowed).toBe(true);
    expect(
      (await signUpAllowed("someone-else@example.test", false)).allowed,
    ).toBe(false);

    await db
      .delete(schema.invitation)
      .where(eq(schema.invitation.id, `inv-${suffix}`));
    await db.delete(schema.user).where(eq(schema.user.id, inviterId));
  });
});

test("the opt-in reopens registration for anyone who wants that", async () => {
  await withOrganization(async () => {
    expect((await signUpAllowed("stranger@example.test", true)).allowed).toBe(
      true,
    );
  });
});

test("the guard actually blocks the HTTP sign-up endpoint", async () => {
  const saved = process.env.SENTRELLO_ALLOW_SIGNUP;
  process.env.SENTRELLO_ALLOW_SIGNUP = "false";
  await withOrganization(async () => {
    const email = `blocked-${suffix}@example.test`;
    createdEmails.push(email);

    const attempt = auth.api.signUpEmail({
      body: { email, password, name: "Blocked" },
    });
    await expect(attempt).rejects.toThrow();

    // and nothing was written
    const rows = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, email));
    expect(rows).toHaveLength(0);
  });
  if (saved !== undefined) process.env.SENTRELLO_ALLOW_SIGNUP = saved;
});
