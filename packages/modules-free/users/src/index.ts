import { auth } from "@sentrello/auth";
import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import { defineModule } from "@sentrello/module-sdk";
import { and, desc, eq, inArray } from "drizzle-orm";
import { temporaryPassword } from "./password";

/**
 * Who is on this instance, and what each of them may do.
 *
 * This was a screen for editing roles, which is half the job: an administrator
 * whose bookkeeper has left, or whose foreman has locked himself out, or who
 * has just watched somebody lose their phone with the authenticator on it, was
 * sent to a terminal. On a self-hosted instance the administrator is usually
 * the owner of the business, and "ssh in and run a command" is not a thing
 * they are going to do at half past four on a Friday.
 *
 * Everything here is deliberately behind `settings:update` — the same
 * permission that renames the business — because these are the actions that
 * can hand somebody else's account away.
 */

/** The details of one person, as an administrator needs to see them. */
interface Person {
  userId: string;
  memberId: string;
  name: string;
  email: string;
  role: string;
  twoFactorEnabled: boolean;
  /** The last time they actually used it, or null if they never have. */
  lastSeenAt: Date | null;
  /** Whether this is the person doing the looking. */
  you: boolean;
}

export default defineModule({
  id: "users",
  tier: "free",
  register(ctx) {
    ctx.registerNav({
      id: "users",
      label: "Users",
      order: 91,
      group: "Configure",
      // Adding and removing people is an owner's job, and somebody who cannot
      // do it learns nothing useful from being shown the screen.
      requires: { settings: ["update"] },
    });

    ctx.app.get(
      "/api/users",
      requireSession(),
      requirePermission({ settings: ["update"] }),
      async (c) => {
        const session = c.get("session");
        const orgId = activeOrganizationId(session);

        const members = await db
          .select({
            memberId: schema.member.id,
            userId: schema.member.userId,
            role: schema.member.role,
            joinedAt: schema.member.createdAt,
          })
          .from(schema.member)
          .where(eq(schema.member.organizationId, orgId));

        const userIds = members.map((m) => m.userId);
        const [users, twoFactor, sessions] = await Promise.all([
          userIds.length
            ? db
                .select({
                  id: schema.user.id,
                  name: schema.user.name,
                  email: schema.user.email,
                  twoFactorEnabled: schema.user.twoFactorEnabled,
                })
                .from(schema.user)
                .where(inArray(schema.user.id, userIds))
            : [],
          userIds.length
            ? db
                .select({ userId: schema.twoFactor.userId })
                .from(schema.twoFactor)
                .where(inArray(schema.twoFactor.userId, userIds))
            : [],
          userIds.length
            ? db
                .select({
                  userId: schema.session.userId,
                  updatedAt: schema.session.updatedAt,
                })
                .from(schema.session)
                .where(inArray(schema.session.userId, userIds))
                .orderBy(desc(schema.session.updatedAt))
            : [],
        ]);

        const byId = new Map(users.map((u) => [u.id, u]));
        const hasSecret = new Set(twoFactor.map((t) => t.userId));
        const lastSeen = new Map<string, Date>();
        for (const s of sessions) {
          if (!lastSeen.has(s.userId)) lastSeen.set(s.userId, s.updatedAt);
        }

        const people: Person[] = members.map((m) => {
          const user = byId.get(m.userId);
          return {
            memberId: m.memberId,
            userId: m.userId,
            name: user?.name ?? "",
            email: user?.email ?? "",
            role: m.role,
            // Both, because a half-finished setup leaves a secret with the
            // flag still off, and an administrator looking at this screen
            // wants to know there is something to revoke.
            twoFactorEnabled:
              Boolean(user?.twoFactorEnabled) || hasSecret.has(m.userId),
            lastSeenAt: lastSeen.get(m.userId) ?? null,
            you: m.userId === session.user.id,
          };
        });

        const invitations = await db
          .select({
            id: schema.invitation.id,
            email: schema.invitation.email,
            role: schema.invitation.role,
            status: schema.invitation.status,
            expiresAt: schema.invitation.expiresAt,
          })
          .from(schema.invitation)
          .where(
            and(
              eq(schema.invitation.organizationId, orgId),
              eq(schema.invitation.status, "pending"),
            ),
          );

        return c.json({ people, invitations });
      },
    );

    ctx.app.post(
      "/api/users/:userId/role",
      requireSession(),
      requirePermission({ settings: ["update"] }),
      async (c) => {
        const session = c.get("session");
        const orgId = activeOrganizationId(session);
        const userId = c.req.param("userId");
        const body = (await c.req.json().catch(() => ({}))) as {
          role?: unknown;
        };
        const role = String(body.role ?? "").trim();
        if (!role) return c.json({ error: "a role is required" }, 400);

        // An administrator who demotes themselves has locked the business out
        // of its own instance, and nobody else can put it right.
        if (userId === session.user.id) {
          return c.json(
            { error: "you cannot change your own role — ask another admin" },
            400,
          );
        }

        const [member] = await db
          .select({ id: schema.member.id })
          .from(schema.member)
          .where(
            and(
              eq(schema.member.userId, userId),
              eq(schema.member.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!member) return c.json({ error: "not found" }, 404);

        // Through Better Auth rather than by writing the row: it is the thing
        // that decides whether a role may be granted at all, and a direct
        // update would sidestep that quietly.
        await auth.api.updateMemberRole({
          body: { memberId: member.id, role, organizationId: orgId },
          headers: c.req.raw.headers,
        });
        return c.json({ ok: true });
      },
    );

    /**
     * Taking somebody off the instance.
     *
     * Their membership goes and their sessions end. The user record itself
     * stays: invoices, notes and activities point at it, and a business that
     * loses who raised an invoice when somebody leaves has lost its own
     * history.
     */
    ctx.app.delete(
      "/api/users/:userId",
      requireSession(),
      requirePermission({ settings: ["update"] }),
      async (c) => {
        const session = c.get("session");
        const orgId = activeOrganizationId(session);
        const userId = c.req.param("userId");

        if (userId === session.user.id) {
          return c.json({ error: "you cannot remove yourself" }, 400);
        }

        const members = await db
          .select({ id: schema.member.id, role: schema.member.role })
          .from(schema.member)
          .where(eq(schema.member.organizationId, orgId));

        const [mine] = await db
          .select({ id: schema.member.id, role: schema.member.role })
          .from(schema.member)
          .where(
            and(
              eq(schema.member.userId, userId),
              eq(schema.member.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!mine) return c.json({ error: "not found" }, 404);

        // The last administrator cannot be removed. An instance with none is
        // one nobody can invite anybody back into.
        const admins = members.filter((m) => m.role === "admin");
        if (mine.role === "admin" && admins.length <= 1) {
          return c.json(
            { error: "this is the last administrator; promote somebody first" },
            400,
          );
        }

        await db.delete(schema.member).where(eq(schema.member.id, mine.id));
        await db
          .delete(schema.session)
          .where(eq(schema.session.userId, userId));
        return c.json({ removed: true });
      },
    );

    /**
     * Giving somebody their way back in.
     *
     * A temporary password shown once, rather than a link in an email, because
     * an instance with no mail configured is the normal case and its owner is
     * standing next to the person who is locked out. Every existing session
     * ends: if the password was reset because somebody else had it, leaving
     * their session alive defeats the point.
     */
    ctx.app.post(
      "/api/users/:userId/password",
      requireSession(),
      requirePermission({ settings: ["update"] }),
      async (c) => {
        const session = c.get("session");
        const orgId = activeOrganizationId(session);
        const userId = c.req.param("userId");

        const [member] = await db
          .select({ id: schema.member.id })
          .from(schema.member)
          .where(
            and(
              eq(schema.member.userId, userId),
              eq(schema.member.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!member) return c.json({ error: "not found" }, 404);

        const password = temporaryPassword();
        const context = await auth.$context;
        const hash = await context.password.hash(password);
        await context.internalAdapter.updatePassword(userId, hash);
        await db
          .delete(schema.session)
          .where(eq(schema.session.userId, userId));

        // Returned once and never stored. The administrator reads it out and
        // the person changes it; anything else means a password sitting in a
        // database column waiting to be found.
        return c.json({ password });
      },
    );

    /**
     * Taking two-factor off an account.
     *
     * The phone with the authenticator on it is in a river, and the backup
     * codes are in a drawer at home. Without this the only way back is a
     * terminal, so the practical outcome is that nobody turns two-factor on at
     * all — which is worse than an administrator being able to remove it.
     *
     * Sessions end with it, so this cannot be used to quietly take over an
     * account that is currently signed in somewhere.
     */
    ctx.app.post(
      "/api/users/:userId/two-factor/revoke",
      requireSession(),
      requirePermission({ settings: ["update"] }),
      async (c) => {
        const session = c.get("session");
        const orgId = activeOrganizationId(session);
        const userId = c.req.param("userId");

        const [member] = await db
          .select({ id: schema.member.id })
          .from(schema.member)
          .where(
            and(
              eq(schema.member.userId, userId),
              eq(schema.member.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!member) return c.json({ error: "not found" }, 404);

        await db
          .delete(schema.twoFactor)
          .where(eq(schema.twoFactor.userId, userId));
        await db
          .update(schema.user)
          .set({ twoFactorEnabled: false })
          .where(eq(schema.user.id, userId));
        await db
          .delete(schema.session)
          .where(eq(schema.session.userId, userId));

        return c.json({ revoked: true });
      },
    );

    /** Signing somebody out everywhere, without changing anything else. */
    ctx.app.post(
      "/api/users/:userId/sessions/revoke",
      requireSession(),
      requirePermission({ settings: ["update"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const userId = c.req.param("userId");
        const [member] = await db
          .select({ id: schema.member.id })
          .from(schema.member)
          .where(
            and(
              eq(schema.member.userId, userId),
              eq(schema.member.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!member) return c.json({ error: "not found" }, 404);

        const gone = await db
          .delete(schema.session)
          .where(eq(schema.session.userId, userId))
          .returning({ id: schema.session.id });
        return c.json({ signedOut: gone.length });
      },
    );
  },
});

export { temporaryPassword } from "./password";
