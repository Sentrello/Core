import { db, schema } from "@sentrello/db";
import { and, desc, eq } from "drizzle-orm";

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
  | "invitation.cancelled";

/** What each one says in a sentence, for the screen and for support. */
export const ACTION_TEXT: Record<SecurityAction, string> = {
  "role.changed": "changed the role of",
  "password.reset": "issued a new password for",
  "two-factor.revoked": "turned off two-factor for",
  "sessions.revoked": "signed out every device of",
  "member.removed": "removed",
  "member.invited": "invited",
  "invitation.cancelled": "withdrew the invitation to",
};

export async function record(input: {
  organizationId: string;
  actor: { id: string; name?: string | null; email?: string | null };
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
      actorId: input.actor.id,
      actorName: who(input.actor),
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

/** The most recent changes, newest first. */
export async function recent(organizationId: string, limit = 25) {
  return db
    .select()
    .from(schema.securityEvents)
    .where(and(eq(schema.securityEvents.organizationId, organizationId)))
    .orderBy(desc(schema.securityEvents.at))
    .limit(limit);
}
