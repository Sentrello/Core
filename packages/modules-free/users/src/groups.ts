import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, asc, db, eq, schema } from "@sentrello/db";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import { record } from "./record";
import {
  BUILT_IN,
  applyRoles,
  builtInPermissions,
  effectiveRoles,
  knownRoles,
  membersOfGroup,
  permissionMap,
  policyFor,
} from "./roles";

/**
 * Groups, roles and the rules a business sets for signing in.
 *
 * All of it behind `settings:update` — the same permission that renames the
 * business — because every route here can hand somebody else's access around.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const idFrom = (c: RouteContext, name = "id") => {
  const value = c.req.param(name);
  return value && UUID.test(value) ? value : null;
};

export function registerGroups(ctx: ModuleContext) {
  /**
   * What the platform guards, and what each role may do about it.
   *
   * An administrator deciding who should be in "the office" needs to see what
   * that would let them do. Read from the roles themselves rather than written
   * down again — a second copy is a screen that disagrees with the checks.
   */
  ctx.app.get(
    "/api/users/roles",
    requireSession(),
    requirePermission({ settings: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const names = await knownRoles(orgId, c.req.raw.headers);

      return c.json({
        permissions: permissionMap(),
        roles: names.map((role) => ({
          role,
          builtIn: (BUILT_IN as readonly string[]).includes(role),
          allows: builtInPermissions(role),
        })),
      });
    },
  );

  ctx.app.get(
    "/api/users/groups",
    requireSession(),
    requirePermission({ settings: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));

      const groups = await db
        .select()
        .from(schema.userGroups)
        .where(eq(schema.userGroups.organizationId, orgId))
        .orderBy(asc(schema.userGroups.name));

      const members = await db
        .select({
          groupId: schema.userGroupMembers.groupId,
          userId: schema.userGroupMembers.userId,
          name: schema.user.name,
          email: schema.user.email,
        })
        .from(schema.userGroupMembers)
        .innerJoin(
          schema.user,
          eq(schema.user.id, schema.userGroupMembers.userId),
        )
        .where(eq(schema.userGroupMembers.organizationId, orgId));

      return c.json({
        groups: groups.map((group) => ({
          ...group,
          members: members
            .filter((m) => m.groupId === group.id)
            .map((m) => ({ userId: m.userId, name: m.name, email: m.email })),
        })),
      });
    },
  );

  ctx.app.post(
    "/api/users/groups",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const name = String(body.name ?? "")
        .trim()
        .slice(0, 60);
      if (!name) return c.json({ error: "a name is required" }, 400);

      const allowed = await knownRoles(orgId, c.req.raw.headers);
      const roles = Array.isArray(body.roles)
        ? [...new Set(body.roles.map(String))].filter((r) =>
            allowed.includes(r),
          )
        : [];

      try {
        const [group] = await db
          .insert(schema.userGroups)
          .values({
            organizationId: orgId,
            name,
            description: String(body.description ?? "").trim() || null,
            roles,
          })
          .returning();
        await record({
          organizationId: orgId,
          actor: session.user,
          subject: { id: group?.id ?? "", name, email: null },
          action: "group.created",
          detail: { roles },
        });
        return c.json({ group }, 201);
      } catch {
        return c.json({ error: "a group already has that name" }, 409);
      }
    },
  );

  /**
   * Changing what a group carries.
   *
   * Every member's roles are recomputed here rather than the next time they
   * sign in: an administrator who takes the books away from "the fitters"
   * means now, not tomorrow morning.
   */
  ctx.app.patch(
    "/api/users/groups/:id",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const id = idFrom(c);
      if (!id) return c.json({ error: "not found" }, 404);

      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const patch: Record<string, unknown> = {};

      if (typeof body.name === "string" && body.name.trim()) {
        patch.name = body.name.trim().slice(0, 60);
      }
      if (body.description !== undefined) {
        patch.description = String(body.description ?? "").trim() || null;
      }
      if (body.roles !== undefined) {
        const allowed = await knownRoles(orgId, c.req.raw.headers);
        const wanted = Array.isArray(body.roles)
          ? [...new Set(body.roles.map(String))]
          : [];
        const unknown = wanted.filter((r) => !allowed.includes(r));
        if (unknown.length > 0) {
          // A group naming a role nobody defined grants nothing and looks like
          // it grants something.
          return c.json(
            { error: `there is no role called ${unknown[0]}` },
            400,
          );
        }
        patch.roles = wanted;
      }
      if (Object.keys(patch).length === 0) {
        return c.json({ error: "nothing to change" }, 400);
      }

      const [updated] = await db
        .update(schema.userGroups)
        .set(patch)
        .where(
          and(
            eq(schema.userGroups.id, id),
            eq(schema.userGroups.organizationId, orgId),
          ),
        )
        .returning();
      if (!updated) return c.json({ error: "not found" }, 404);

      for (const userId of await membersOfGroup(id)) {
        await applyRoles(orgId, userId);
      }
      await record({
        organizationId: orgId,
        actor: session.user,
        subject: { id: updated.id, name: updated.name, email: null },
        action: "group.changed",
        detail: { roles: updated.roles },
      });
      return c.json({ group: updated });
    },
  );

  ctx.app.delete(
    "/api/users/groups/:id",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const id = idFrom(c);
      if (!id) return c.json({ error: "not found" }, 404);

      const affected = await membersOfGroup(id);
      const [gone] = await db
        .delete(schema.userGroups)
        .where(
          and(
            eq(schema.userGroups.id, id),
            eq(schema.userGroups.organizationId, orgId),
          ),
        )
        .returning();
      if (!gone) return c.json({ error: "not found" }, 404);

      await db
        .delete(schema.userGroupMembers)
        .where(eq(schema.userGroupMembers.groupId, id));
      // Everybody in it keeps their own role and loses the group's, which is
      // what deleting a group means.
      for (const userId of affected) await applyRoles(orgId, userId);

      await record({
        organizationId: orgId,
        actor: session.user,
        subject: { id: gone.id, name: gone.name, email: null },
        action: "group.deleted",
        detail: { people: affected.length },
      });
      return c.json({ ok: true });
    },
  );

  /** Putting somebody in a group, or taking them out. */
  ctx.app.post(
    "/api/users/groups/:id/members",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const id = idFrom(c);
      if (!id) return c.json({ error: "not found" }, 404);

      const body = (await c.req.json().catch(() => ({}))) as {
        userId?: unknown;
      };
      const userId = String(body.userId ?? "");
      if (!userId) return c.json({ error: "a person is required" }, 400);

      const [group] = await db
        .select()
        .from(schema.userGroups)
        .where(
          and(
            eq(schema.userGroups.id, id),
            eq(schema.userGroups.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!group) return c.json({ error: "not found" }, 404);

      // Only somebody who is already in the business. A group is not a way in.
      const [member] = await db
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.organizationId, orgId),
            eq(schema.member.userId, userId),
          ),
        )
        .limit(1);
      if (!member) return c.json({ error: "no such person here" }, 404);

      await db
        .insert(schema.userGroupMembers)
        .values({
          groupId: id,
          userId,
          organizationId: orgId,
          addedBy: session.user.id,
        })
        .onConflictDoNothing();

      const roles = await applyRoles(orgId, userId);
      await record({
        organizationId: orgId,
        actor: session.user,
        subject: await personOf(userId),
        action: "group.joined",
        detail: { group: group.name, roles: roles.all },
      });
      return c.json({ roles }, 201);
    },
  );

  ctx.app.delete(
    "/api/users/groups/:id/members/:userId",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const id = idFrom(c);
      const userId = c.req.param("userId") ?? "";
      if (!id || !userId) return c.json({ error: "not found" }, 404);

      const [gone] = await db
        .delete(schema.userGroupMembers)
        .where(
          and(
            eq(schema.userGroupMembers.groupId, id),
            eq(schema.userGroupMembers.userId, userId),
            eq(schema.userGroupMembers.organizationId, orgId),
          ),
        )
        .returning();
      if (!gone) return c.json({ error: "not found" }, 404);

      const roles = await applyRoles(orgId, userId);
      await record({
        organizationId: orgId,
        actor: session.user,
        subject: await personOf(userId),
        action: "group.left",
        detail: { roles: roles.all },
      });
      return c.json({ roles });
    },
  );

  /** What one person holds, and where each part of it comes from. */
  ctx.app.get(
    "/api/users/:userId/access",
    requireSession(),
    requirePermission({ settings: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const userId = c.req.param("userId") ?? "";
      const roles = await effectiveRoles(orgId, userId);
      if (roles.all.length === 0 && !roles.base) {
        return c.json({ error: "not found" }, 404);
      }
      return c.json({ roles, groups: await groupNames(orgId, userId) });
    },
  );

  // --- the rules for signing in ---------------------------------------------

  ctx.app.get(
    "/api/users/policy",
    requireSession(),
    requirePermission({ settings: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      return c.json({ policy: await policyFor(orgId) });
    },
  );

  ctx.app.put(
    "/api/users/policy",
    requireSession(),
    requirePermission({ settings: ["update"] }),
    async (c: RouteContext) => {
      const session = c.get("session");
      const orgId = activeOrganizationId(session);
      const current = await policyFor(orgId);
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const allowed = await knownRoles(orgId, c.req.raw.headers);
      const requireTwoFactorFor = Array.isArray(body.requireTwoFactorFor)
        ? [...new Set(body.requireTwoFactorFor.map(String))].filter((r) =>
            allowed.includes(r),
          )
        : current.requireTwoFactorFor;

      const minPasswordLength = Number.isInteger(body.minPasswordLength)
        ? Math.min(Math.max(body.minPasswordLength as number, 8), 72)
        : current.minPasswordLength;

      const sessionDays =
        body.sessionDays === null
          ? null
          : Number.isInteger(body.sessionDays)
            ? Math.min(Math.max(body.sessionDays as number, 1), 365)
            : current.sessionDays;

      const [updated] = await db
        .update(schema.securityPolicy)
        .set({
          requireTwoFactorFor,
          minPasswordLength,
          sessionDays,
          updatedAt: new Date(),
        })
        .where(eq(schema.securityPolicy.organizationId, orgId))
        .returning();

      await record({
        organizationId: orgId,
        actor: session.user,
        subject: { id: orgId, name: "this business", email: null },
        action: "policy.changed",
        detail: { requireTwoFactorFor, minPasswordLength, sessionDays },
      });
      return c.json({ policy: updated });
    },
  );
}

async function groupNames(orgId: string, userId: string): Promise<string[]> {
  const rows = await db
    .select({ name: schema.userGroups.name })
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
  return rows.map((r) => r.name);
}

async function personOf(userId: string) {
  const [person] = await db
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
    })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  return person ?? { id: userId, name: null, email: null };
}
