import { and, desc, eq, inArray, not } from "drizzle-orm";
import { db } from "./client";
import * as schema from "./schema";

/**
 * Writing down who did what to whose account.
 *
 * Every action on the Users screen hands access around, and the only answer to
 * "who reset that password, and when" was previously somebody's memory. A
 * business with three people can shrug at that; one with fifteen, or one being
 * asked the question by an insurer, cannot.
 *
 * Names are copied alongside ids on purpose. The id is the truth, but a
 * removed member's name would otherwise resolve to nothing and the log would
 * read "somebody did something to somebody" exactly when it matters most.
 */

export type SecurityAction =
  | "role.changed"
  | "password.reset"
  | "two-factor.revoked"
  | "sessions.revoked"
  | "member.removed"
  | "member.invited"
  | "invitation.cancelled"
  | "group.created"
  | "group.changed"
  | "group.deleted"
  | "group.joined"
  | "group.left"
  | "policy.changed"
  | "session.revoked"
  | "sso.connected"
  | "sso.disconnected"
  | "sign-in.succeeded"
  | "sign-in.failed"
  | "account.unlocked"
  | "account.disabled"
  | "account.enabled"
  | "events.pruned";

/** What each one says in a sentence, for the screen and for support. */
export const ACTION_TEXT: Record<SecurityAction, string> = {
  "role.changed": "changed the role of",
  "password.reset": "issued a new password for",
  "two-factor.revoked": "turned off two-factor for",
  "sessions.revoked": "signed out every device of",
  "member.removed": "removed",
  "member.invited": "invited",
  "invitation.cancelled": "withdrew the invitation to",
  "group.created": "created the group",
  "group.changed": "changed what is granted by",
  "group.deleted": "deleted the group",
  "group.joined": "added to a group",
  "group.left": "took out of a group",
  "policy.changed": "changed the sign-in rules for",
  "session.revoked": "signed out a device of",
  "sso.connected": "connected sign-in for",
  "sso.disconnected": "disconnected sign-in for",
  "sign-in.succeeded": "signed in",
  "sign-in.failed": "failed to sign in as",
  "account.unlocked": "unlocked the account of",
  "account.disabled": "suspended",
  "account.enabled": "restored",
  // No trailing "for": this one is about the organization's whole log, not
  // about a person, so it is the only action here that never has a subject.
  // Phrased to end where the sentence ends, or the Events screen renders
  // "…retention period for —".
  "events.pruned": "removed history older than the retention period",
};

export async function record(input: {
  organizationId: string;
  /**
   * The person who did it, or null where there is nobody — a sign-in attempt
   * against an address that belongs to no account. Writing a name in that
   * case would be inventing one; null here is what keeps a failed attempt
   * against a stranger's address indistinguishable from one against a real
   * address with the wrong password, which is what stops the log itself from
   * revealing whether an address exists.
   */
  actor: { id: string; name?: string | null; email?: string | null } | null;
  subject?: { id?: string | null; name?: string | null; email?: string | null };
  action: SecurityAction;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const who = (person?: {
    name?: string | null;
    email?: string | null;
  }): string => person?.name?.trim() || person?.email?.trim() || "someone";

  // Never allowed to fail the action it describes. An administrator locked out
  // of their own instance because the log could not be written would be a
  // worse outcome than a gap in the log — and the gap is visible, which the
  // failure would not be.
  try {
    await db.insert(schema.securityEvents).values({
      organizationId: input.organizationId,
      actorId: input.actor?.id ?? null,
      actorName: input.actor ? who(input.actor) : null,
      subjectId: input.subject?.id ?? null,
      subjectName: input.subject ? who(input.subject) : null,
      action: input.action,
      detail: input.detail ?? null,
    });
  } catch (err) {
    console.error(
      `[users] could not record ${input.action}: ${(err as Error).message}`,
    );
  }
}

/**
 * The most recent changes, newest first.
 *
 * `exclude` is applied inside the query, ahead of `limit` — not as a filter
 * on the rows this returns. A card asking for the 25 most recent
 * *administrative* actions has to exclude sign-in noise from the window the
 * 25 are drawn from; filtering an already-limited page after the fact would
 * still lose an administrative row to twenty-five bot attempts that arrived
 * more recently, which is the exact bug this parameter exists to close (see
 * `packages/modules-free/users/src/people.ts`'s `GET /api/users`).
 */
export async function recent(
  organizationId: string,
  limit = 25,
  options?: { exclude?: SecurityAction[] },
) {
  const exclude = options?.exclude;
  return db
    .select()
    .from(schema.securityEvents)
    .where(
      and(
        eq(schema.securityEvents.organizationId, organizationId),
        exclude?.length
          ? not(inArray(schema.securityEvents.action, exclude))
          : undefined,
      ),
    )
    .orderBy(desc(schema.securityEvents.at))
    .limit(limit);
}
