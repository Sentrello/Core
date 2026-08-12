import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import { auth } from "./index";
import { resetPasswordForEmail } from "./reset-password";
import { signUpAsOwner } from "./testing";

/**
 * The way back in when email cannot help.
 *
 * A self-hosted instance may have no mail configured at all, and its owner is
 * usually the only administrator — so a forgotten password had no route back
 * except editing the database by hand.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const email = `locked-out-${suffix}@example.test`;
const original = "correct-horse-battery-staple";

beforeAll(async () => {
  await signUpAsOwner({ email, password: original, name: "Locked Out" });
});

afterAll(async () => {
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

const signIn = (password: string) =>
  auth.api
    .signInEmail({ body: { email, password }, asResponse: true })
    .then((r) => r.status)
    .catch(() => 401);

test("the new password works and the old one stops working", async () => {
  expect(await signIn(original)).toBe(200);

  const result = await resetPasswordForEmail(email, "a-brand-new-password");
  expect(result.ok).toBe(true);

  expect(await signIn("a-brand-new-password")).toBe(200);
  expect(await signIn(original)).not.toBe(200);
});

test("existing sessions are ended, not left open", async () => {
  // Resetting because someone else had the password is pointless if their
  // session survives it.
  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (!u) throw new Error("expected the test user");

  await auth.api.signInEmail({
    body: { email, password: "a-brand-new-password" },
    asResponse: true,
  });
  const before = await db
    .select()
    .from(schema.session)
    .where(eq(schema.session.userId, u.id));
  expect(before.length).toBeGreaterThan(0);

  await resetPasswordForEmail(email, "another-new-password");

  const after = await db
    .select()
    .from(schema.session)
    .where(eq(schema.session.userId, u.id));
  expect(after).toHaveLength(0);
});

test("an unknown address is refused without saying more", async () => {
  const result = await resetPasswordForEmail(
    "nobody@example.test",
    "whatever-long",
  );
  expect(result.ok).toBe(false);
});

test("a password too short to be worth setting is refused", async () => {
  const result = await resetPasswordForEmail(email, "short");
  expect(result).toEqual({
    ok: false,
    reason: "the password must be at least 8 characters",
  });
  // And the account still opens with the one it had.
  expect(await signIn("another-new-password")).toBe(200);
});
