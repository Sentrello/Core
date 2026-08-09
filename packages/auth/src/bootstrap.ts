import { db, schema } from "@sentrello/db";
import { auth } from "./index";

export interface OwnerDetails {
  email: string;
  password: string;
  name: string;
  organizationName?: string;
}

/**
 * First-run bootstrap. On an empty instance, create the single organization
 * (the tenant boundary from Build Plan §6.1) and the owner account, then never
 * prompt again. Idempotent: a second boot finds the org and returns early.
 */
export async function ensureBootstrapped(owner?: OwnerDetails) {
  const existing = await db.select().from(schema.organizations).limit(1);
  if (existing.length > 0) return { bootstrapped: false as const };
  if (!owner) return { bootstrapped: false as const }; // installer supplies these on first run

  const signUp = await auth.api.signUpEmail({
    body: { email: owner.email, password: owner.password, name: owner.name },
    returnHeaders: true,
  });

  // The organization created here IS the instance's tenant boundary, and the
  // creator gets `creatorRole: "admin"` (the Instance Owner).
  const name = owner.organizationName ?? `${owner.name}'s business`;
  const organization = await auth.api.createOrganization({
    body: { name, slug: slugify(name) },
    headers: signUp.headers,
  });

  return { bootstrapped: true as const, organization };
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "sentrello";
}
