import { auth, roles as builtInRoles, statement } from "@sentrello/auth";
import { and, db, eq, schema } from "@sentrello/db";

/**
 * What somebody may do, and where it comes from.
 *
 * Learned from Keycloak, which separates three things this platform used to
 * run together: a **role** is a named set of permissions; a **group** is a set
 * of people; and what a person actually holds is their own role plus the roles
 * of every group they are in.
 *
 * That last part is computed, never typed. `member.role` is comma separated,
 * which Better Auth splits and allows a permission if any of the roles grants
 * it — so groups arrive without a single existing permission check having to
 * know they exist.
 */

/** The roles built into the platform, in the order a screen should list them. */
export const BUILT_IN = ["admin", "accounting", "staff", "customer"] as const;

/** Every resource the platform guards, and what can be done to each. */
export function permissionMap(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [resource, actions] of Object.entries(statement)) {
    out[resource] = [...(actions as readonly string[])];
  }
  return out;
}

/**
 * What a built-in role can do, read from the role itself.
 *
 * Read rather than written down again: a second copy of this list is a screen
 * that tells an administrator something the permission checks disagree with,
 * and they would believe the screen.
 */
export function builtInPermissions(role: string): Record<string, string[]> {
  const known = builtInRoles as unknown as Record<
    string,
    { statements?: Record<string, readonly string[]> } | undefined
  >;
  const found = known[role];
  if (!found?.statements) return {};

  const out: Record<string, string[]> = {};
  for (const [resource, actions] of Object.entries(found.statements)) {
    if (Array.isArray(actions) && actions.length > 0) {
      out[resource] = [...actions];
    }
  }
  return out;
}

/** Groups this person is in, with the roles each carries. */
export async function groupsOf(
  orgId: string,
  userId: string,
): Promise<(typeof schema.userGroups.$inferSelect)[]> {
  return db
    .select({
      id: schema.userGroups.id,
      organizationId: schema.userGroups.organizationId,
      name: schema.userGroups.name,
      description: schema.userGroups.description,
      roles: schema.userGroups.roles,
      createdAt: schema.userGroups.createdAt,
    })
    .from(schema.userGroupMembers)
    .innerJoin(
      schema.userGroups,
      eq(schema.userGroups.id, schema.userGroupMembers.groupId),
    )
    .where(
      and(
        eq(schema.userGroupMembers.organizationId, orgId),
        eq(schema.userGroupMembers.userId, userId),
      ),
    );
}

export interface EffectiveRoles {
  /** The role this person was given directly. */
  base: string | null;
  /** Roles that arrive through a group, and which group each came from. */
  fromGroups: { role: string; group: string }[];
  /** Everything, deduplicated — what `member.role` is set to. */
  all: string[];
}

/** Works out what somebody holds, without writing anything. */
export async function effectiveRoles(
  orgId: string,
  userId: string,
): Promise<EffectiveRoles> {
  const [member] = await db
    .select({ role: schema.member.role, baseRole: schema.member.baseRole })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.organizationId, orgId),
        eq(schema.member.userId, userId),
      ),
    )
    .limit(1);
  if (!member) return { base: null, fromGroups: [], all: [] };

  // An instance that has never had groups has no base role written down, and
  // its members' single role is their own. Read it rather than migrating: the
  // first change to either writes both.
  const base = member.baseRole ?? member.role.split(",")[0] ?? null;

  const fromGroups: { role: string; group: string }[] = [];
  for (const group of await groupsOf(orgId, userId)) {
    for (const role of group.roles) {
      fromGroups.push({ role, group: group.name });
    }
  }

  const all = [...new Set([base, ...fromGroups.map((g) => g.role)])].filter(
    (role): role is string => Boolean(role),
  );
  return { base, fromGroups, all };
}

/**
 * Writes the computed roles back onto the membership.
 *
 * Called after anything that could change them: a role given directly, a
 * person added to or taken out of a group, a group's own roles edited. One
 * function so there is one answer, and it is the same answer every time.
 */
export async function applyRoles(
  orgId: string,
  userId: string,
): Promise<EffectiveRoles> {
  const roles = await effectiveRoles(orgId, userId);
  if (roles.all.length === 0) return roles;

  await db
    .update(schema.member)
    .set({ baseRole: roles.base, role: roles.all.join(",") })
    .where(
      and(
        eq(schema.member.organizationId, orgId),
        eq(schema.member.userId, userId),
      ),
    );
  return roles;
}

/** Everybody whose roles a group change affects. */
export async function membersOfGroup(groupId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: schema.userGroupMembers.userId })
    .from(schema.userGroupMembers)
    .where(eq(schema.userGroupMembers.groupId, groupId));
  return rows.map((r) => r.userId);
}

/**
 * Role names this organization can actually grant.
 *
 * The built-ins plus whatever the business has defined for itself. Checked
 * before a group is allowed to carry a role, because a group naming a role
 * nobody defined grants nothing and looks like it grants something.
 */
export async function knownRoles(
  orgId: string,
  headers: Headers,
): Promise<string[]> {
  const custom = await auth.api
    .listOrgRoles({ query: { organizationId: orgId }, headers })
    .catch(() => [] as { role: string }[]);

  const names = Array.isArray(custom)
    ? custom.map((r) => r.role)
    : ((custom as { roles?: { role: string }[] }).roles ?? []).map(
        (r) => r.role,
      );
  return [...new Set([...BUILT_IN, ...names])];
}

/**
 * Whether this person must have a second factor.
 *
 * Asked of the roles they hold rather than of them: the person who can move
 * money is not the person who clocks in on a shared tablet, and a business
 * that has to force both will force neither.
 */
export function twoFactorRequired(
  policy: { requireTwoFactorFor: string[] } | null,
  roles: string[],
): boolean {
  if (!policy || policy.requireTwoFactorFor.length === 0) return false;
  return roles.some((role) => policy.requireTwoFactorFor.includes(role));
}

/** The policy for an organization, with the platform's defaults filled in. */
export async function policyFor(
  orgId: string,
): Promise<typeof schema.securityPolicy.$inferSelect> {
  const [existing] = await db
    .select()
    .from(schema.securityPolicy)
    .where(eq(schema.securityPolicy.organizationId, orgId))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(schema.securityPolicy)
    .values({ organizationId: orgId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const [raced] = await db
    .select()
    .from(schema.securityPolicy)
    .where(eq(schema.securityPolicy.organizationId, orgId))
    .limit(1);
  if (!raced) throw new Error("could not resolve the security policy");
  return raced;
}
