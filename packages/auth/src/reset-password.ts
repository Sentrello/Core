/**
 * Set a password from the host, for when email cannot help.
 *
 * A self-hosted instance may have no mail configured, and its owner is usually
 * the only administrator — so a forgotten password had no route back except
 * editing the database by hand. Anyone who can run this already has shell on
 * the machine holding the database, so it grants nothing they did not have;
 * what it saves is them doing it with a SQL client and a hashing library.
 *
 * Run through the CLI: `sentrello reset-password <email>`.
 */
import { db, schema } from "@sentrello/db";
import { eq } from "@sentrello/db/orm";
import { auth } from "./index";

export async function resetPasswordForEmail(
  email: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (newPassword.length < 8) {
    return { ok: false, reason: "the password must be at least 8 characters" };
  }

  const [user] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email.toLowerCase()))
    .limit(1);
  if (!user) return { ok: false, reason: `no account for ${email}` };

  // Better Auth's own hashing, rather than writing the hash here: the format
  // is its business and reimplementing it is how accounts stop opening.
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(newPassword);
  await ctx.internalAdapter.updatePassword(user.id, hash);

  // Every existing session ends. If the password was reset because someone
  // else had it, leaving their session alive would defeat the point.
  await db.delete(schema.session).where(eq(schema.session.userId, user.id));

  return { ok: true };
}

if (import.meta.main) {
  const [email, supplied] = process.argv.slice(2);
  if (!email) {
    console.error("usage: reset-password <email> [password]");
    process.exit(1);
  }

  // Generated when not supplied, so a password never has to be invented on the
  // spot or typed into a shell history.
  const password =
    supplied ??
    Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString(
      "base64url",
    );

  const result = await resetPasswordForEmail(email, password);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    process.exit(1);
  }

  console.log(`Password set for ${email}`);
  if (!supplied) console.log(`  ${password}`);
  console.log("All existing sessions for this account have been signed out.");
  process.exit(0);
}
