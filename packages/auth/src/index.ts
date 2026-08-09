import { db, schema } from "@sentrello/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { ac, roles } from "./permissions";

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
  emailAndPassword: { enabled: true, requireEmailVerification: false }, // flip on once email is wired
  ...(google ? { socialProviders: google } : {}),
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
