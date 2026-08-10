import { and, db, eq, schema } from "@sentrello/db";
import { APIError, createAuthMiddleware } from "better-auth/api";

/**
 * Who may create an account on this instance.
 *
 * Left open, every deployed instance is a public sign-up form: anyone who finds
 * the URL can create an account and spin up their own organization inside
 * someone else's install. Sign-up is therefore closed by default, with exactly
 * three ways through:
 *
 *  1. **First run.** No organization exists yet, so this is the owner claiming
 *     a fresh instance. Whoever gets there first owns it — which is why the
 *     installer tells the operator to complete setup immediately.
 *  2. **An invitation.** The address has a pending invitation from someone who
 *     already has the right to invite.
 *  3. **An explicit opt-in**, for anyone genuinely running open registration.
 */
export async function signUpAllowed(
  email: string | undefined,
  openRegistration = process.env.SENTRELLO_ALLOW_SIGNUP === "true",
): Promise<
  { allowed: true; reason: string } | { allowed: false; reason: string }
> {
  if (openRegistration) {
    return { allowed: true, reason: "open registration is enabled" };
  }

  const [existingOrg] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .limit(1);
  if (!existingOrg) {
    return { allowed: true, reason: "first run: claiming a new instance" };
  }

  if (email) {
    const [invitation] = await db
      .select({ id: schema.invitation.id })
      .from(schema.invitation)
      .where(
        and(
          eq(schema.invitation.email, email.toLowerCase()),
          eq(schema.invitation.status, "pending"),
        ),
      )
      .limit(1);
    if (invitation) return { allowed: true, reason: "invited" };
  }

  return { allowed: false, reason: "sign-up is closed on this instance" };
}

/** Rejects sign-ups that `signUpAllowed` does not permit. */
export const signUpGuard = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/sign-up/email") return;

  const email = (ctx.body as { email?: string } | undefined)?.email;
  const decision = await signUpAllowed(email);
  if (!decision.allowed) {
    throw new APIError("FORBIDDEN", {
      message:
        "This Sentrello instance is not accepting new accounts. Ask an administrator for an invitation.",
    });
  }
});
