import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, schema } from "@sentrello/db";
import { eq } from "drizzle-orm";
import { ensureBootstrapped } from "./bootstrap";

const suffix = crypto.randomUUID().slice(0, 8);
const orgId = `bootstrap-${suffix}`;

beforeAll(async () => {
  await db.insert(schema.organizations).values({
    id: orgId,
    name: `Bootstrap ${suffix}`,
    slug: `bootstrap-${suffix}`,
    createdAt: new Date(),
  });
});

afterAll(async () => {
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
});

test("a second boot skips bootstrap and creates nothing", async () => {
  const before = await db.select().from(schema.organizations);

  expect(await ensureBootstrapped()).toEqual({ bootstrapped: false });
  // even when owner details are supplied, an instance that already has an
  // organization must not create a second one
  expect(
    await ensureBootstrapped({
      email: `never-${suffix}@example.test`,
      password: "correct-horse-battery-staple",
      name: "Never Created",
    }),
  ).toEqual({ bootstrapped: false });

  const after = await db.select().from(schema.organizations);
  expect(after.length).toBe(before.length);

  const created = await db
    .select()
    .from(schema.user)
    .where(eq(schema.user.email, `never-${suffix}@example.test`));
  expect(created).toHaveLength(0);
});

test("a fresh instance with no owner details waits rather than guessing", async () => {
  // the installer supplies the owner on first run; until then this is a no-op
  expect(await ensureBootstrapped()).toEqual({ bootstrapped: false });
});
