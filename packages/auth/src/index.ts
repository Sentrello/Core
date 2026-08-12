import { db, schema } from "@sentrello/db";
import { asc, eq } from "@sentrello/db/orm";
import { emailAdapter } from "@sentrello/email";
import { passwordResetEmail } from "@sentrello/email/templates";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { ac, roles } from "./permissions";
import { signUpGuard } from "./signup-policy";

// BYO Google OAuth: only enabled if the instance owner configured it.
const google =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        },
      }
    : undefined;

export const auth = betterAuth({
  baseURL: process.env.SENTRELLO_BASE_URL ?? "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false, // flip on once email is wired
    /**
     * Without this an owner who forgets their password has no way back in
     * except editing the database — and on a self-hosted instance they are
     * usually the only administrator, so there is nobody to ask.
     *
     * An hour, not a day: the link is a bearer credential sitting in an inbox.
     * Instances with no mail configured cannot use this at all, which is what
     * `sentrello reset-password` on the host is for.
     */
    resetPasswordTokenExpiresIn: 60 * 60,
    sendResetPassword: async ({ user, url }) => {
      const mail = passwordResetEmail({ url, expiresInMinutes: 60 });
      await emailAdapter().send({
        to: user.email,
        subject: mail.subject,
        html: mail.html,
      });
    },
  },
  ...(google ? { socialProviders: google } : {}),
  // Closed by default: first-run owner, invitation, or an explicit opt-in.
  hooks: { before: signUpGuard },
  databaseHooks: {
    session: {
      create: {
        /**
         * Give every new session an active organization.
         *
         * Without this, signing in leaves `activeOrganizationId` null, and
         * since every business query is scoped by it the whole application
         * quietly behaves as though the business were empty: lists come back
         * with nothing in them and writes are refused as unauthorised. One
         * organization per instance is the norm, so the first membership is
         * the right answer; a user in several keeps whichever they pick.
         */
        before: async (session) => {
          const [membership] = await db
            .select({ organizationId: schema.member.organizationId })
            .from(schema.member)
            .where(eq(schema.member.userId, session.userId))
            .orderBy(asc(schema.member.createdAt))
            .limit(1);

          return membership
            ? {
                data: {
                  ...session,
                  activeOrganizationId: membership.organizationId,
                },
              }
            : undefined;
        },
      },
    },
  },
  plugins: [
    organization({
      ac,
      roles,
      creatorRole: "admin", // instance owner
      membershipLimit: 100,
      // Better Auth's organization IS the tenant boundary from Build Plan §6.1;
      // point it at the `organizations` table rather than keeping two.
      schema: { organization: { modelName: "organizations" } },
    }),
  ],
});

export type Auth = typeof auth;
export { ac, roles, statement } from "./permissions";
