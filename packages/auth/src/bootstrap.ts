import { db, schema } from "@sentrello/db";
import type { SentrelloApp } from "@sentrello/module-sdk";
import { auth } from "./index";
import { signUpAllowed } from "./signup-policy";

export interface OwnerDetails {
  email: string;
  password: string;
  name: string;
  organizationName?: string;
}

/** True when this instance has no organization, i.e. nobody owns it yet. */
export async function needsBootstrap(): Promise<boolean> {
  const existing = await db.select().from(schema.organizations).limit(1);
  return existing.length === 0;
}

/**
 * First-run bootstrap. Creates the single organization (the tenant boundary
 * from Build Plan §6.1) and the owner account, then never applies again.
 *
 * Idempotent: a second call finds the organization and returns early.
 */
export async function ensureBootstrapped(owner?: OwnerDetails) {
  if (!(await needsBootstrap())) return { bootstrapped: false as const };
  if (!owner) return { bootstrapped: false as const }; // waiting for the operator

  const signUp = await auth.api.signUpEmail({
    body: { email: owner.email, password: owner.password, name: owner.name },
    returnHeaders: true,
  });

  // The organization created here IS the instance's tenant boundary, and the
  // creator gets `creatorRole: "admin"` — the Instance Owner.
  const name = owner.organizationName ?? `${owner.name}'s business`;
  const organization = await auth.api.createOrganization({
    body: { name, slug: slugify(name) },
    headers: signUp.headers,
  });

  return {
    bootstrapped: true as const,
    organization,
    headers: signUp.headers,
  };
}

/**
 * Public first-run endpoints. Every customer install starts here: without them
 * a fresh instance has a sign-in screen and no way to create the account it
 * asks for.
 */
export function registerBootstrapRoutes(app: SentrelloApp) {
  app.get("/api/bootstrap", async (c) => {
    const needed = await needsBootstrap();
    return c.json({
      needed,
      // so the sign-in screen can decide whether to offer a "create account" link
      signUpOpen: (await signUpAllowed(undefined)).allowed,
    });
  });

  app.post("/api/bootstrap", async (c) => {
    if (!(await needsBootstrap())) {
      // Whoever claimed the instance already did; this must never become a
      // second way in.
      return c.json({ error: "already_bootstrapped" }, 409);
    }

    const body = await c.req.json().catch(() => ({}));
    const { email, password, name, organizationName } =
      body as Partial<OwnerDetails>;
    if (!email || !password || !name) {
      return c.json({ error: "email, password and name are required" }, 400);
    }
    if (password.length < 12) {
      return c.json({ error: "password must be at least 12 characters" }, 400);
    }

    const result = await ensureBootstrapped({
      email,
      password,
      name,
      organizationName,
    });
    if (!result.bootstrapped) {
      return c.json({ error: "already_bootstrapped" }, 409);
    }

    // Hand back the session cookie so the owner is signed in immediately.
    const cookie = result.headers.get("set-cookie");
    if (cookie) c.header("set-cookie", cookie);
    return c.json({ organization: result.organization }, 201);
  });
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "sentrello";
}
