/**
 * What a business calls its own pipeline.
 *
 * The deal stages lived in the browser as a five-item constant, which meant
 * every business ran the process a developer happened to pick. A roofer goes
 * quote → measured → scheduled → done; a consultancy looks nothing like that.
 *
 * Absent settings mean the defaults, so an instance that never opens this
 * screen behaves exactly as it did before the table existed.
 */
import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, schema } from "@sentrello/db";
import type { ModuleContext } from "@sentrello/module-sdk";

/** What a pipeline looks like before anybody has said otherwise. */
export const DEFAULT_STAGES = [
  { id: "opportunity", label: "Opportunity" },
  { id: "proposal", label: "Proposal" },
  { id: "negotiation", label: "Negotiation" },
  { id: "won", label: "Won" },
  { id: "lost", label: "Lost" },
];

export const DEFAULT_TASK_TYPES = ["call", "email", "meeting", "other"];

/**
 * Enough for any pipeline anybody actually runs.
 *
 * Worth enforcing rather than trusting the screen: this arrives as JSON from a
 * browser, and a board with four hundred columns is one PUT away.
 */
const MAX_STAGES = 12;
const MAX_TASK_TYPES = 12;

/**
 * The id is what deals store, so it has to survive a rename of the label.
 *
 * Derived from the label only when a stage is first created; after that the
 * browser sends the id back and it is kept. Renaming "Proposal" to "Quote sent"
 * must not orphan every deal sitting in it.
 */
export function stageId(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "stage"
  );
}

interface Stage {
  id: string;
  label: string;
}

/** Reads what the browser sent, and refuses anything a board could not draw. */
export function parseStages(input: unknown): Stage[] {
  if (!Array.isArray(input)) throw new RangeError("stages must be a list");
  if (input.length === 0) {
    throw new RangeError("a pipeline needs at least one stage");
  }
  if (input.length > MAX_STAGES) {
    throw new RangeError(`a pipeline can have at most ${MAX_STAGES} stages`);
  }

  const seen = new Set<string>();
  return input.map((raw) => {
    const label = String((raw as { label?: unknown })?.label ?? "")
      .trim()
      .slice(0, 40);
    if (!label) throw new RangeError("every stage needs a name");

    const given = String((raw as { id?: unknown })?.id ?? "").trim();
    const id = given ? given.slice(0, 40) : stageId(label);
    if (seen.has(id)) {
      throw new RangeError(`there are two stages called "${label}"`);
    }
    seen.add(id);
    return { id, label };
  });
}

export function parseTaskTypes(input: unknown): string[] {
  if (!Array.isArray(input)) throw new RangeError("task types must be a list");
  if (input.length > MAX_TASK_TYPES) {
    throw new RangeError(`at most ${MAX_TASK_TYPES} task types`);
  }
  const types = [
    ...new Set(
      input
        .map((raw) =>
          String(raw ?? "")
            .trim()
            .toLowerCase()
            .slice(0, 30),
        )
        .filter(Boolean),
    ),
  ];
  if (types.length === 0) throw new RangeError("keep at least one task type");
  return types;
}

export function registerCrmSettings(ctx: ModuleContext) {
  ctx.app.get(
    "/api/crm/settings",
    requireSession(),
    // Read, not update: the deals board needs the stages to draw itself, and
    // everybody who can see a deal can see the board.
    requirePermission({ crm: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [row] = await db
        .select()
        .from(schema.crmSettings)
        .where(eq(schema.crmSettings.organizationId, orgId))
        .limit(1);

      return c.json({
        dealStages: row?.dealStages ?? DEFAULT_STAGES,
        taskTypes: row?.taskTypes ?? DEFAULT_TASK_TYPES,
        /** So the screen can say "these are the defaults" rather than guess. */
        usingDefaults: !row,
      });
    },
  );

  ctx.app.put(
    "/api/crm/settings",
    requireSession(),
    requirePermission({ crm: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = await c.req.json().catch(() => ({}));

      let dealStages: Stage[];
      let taskTypes: string[];
      try {
        dealStages = parseStages(body.dealStages);
        taskTypes = parseTaskTypes(body.taskTypes);
      } catch (err) {
        if (err instanceof RangeError)
          return c.json({ error: err.message }, 400);
        throw err;
      }

      /**
       * A stage cannot be removed while deals are standing in it.
       *
       * The alternative is a deal whose stage matches no column: invisible on
       * the board, still in the database, discovered when somebody asks where
       * the job went. Refusing and naming the count lets them move the deals
       * first, which is what they would have to do anyway.
       */
      const keeping = new Set(dealStages.map((stage) => stage.id));
      const orphans = await db
        .select({ stage: schema.deals.stage })
        .from(schema.deals)
        .where(eq(schema.deals.organizationId, orgId));

      const stranded = new Map<string, number>();
      for (const deal of orphans) {
        if (keeping.has(deal.stage)) continue;
        stranded.set(deal.stage, (stranded.get(deal.stage) ?? 0) + 1);
      }
      const worst = [...stranded.entries()][0];
      if (worst) {
        const [name, count] = worst;
        return c.json(
          {
            error: `${count} deal${count === 1 ? " is" : "s are"} still in "${name}". Move them to another stage before removing it.`,
            stranded: Object.fromEntries(stranded),
          },
          409,
        );
      }

      const [saved] = await db
        .insert(schema.crmSettings)
        .values({ organizationId: orgId, dealStages, taskTypes })
        .onConflictDoUpdate({
          target: schema.crmSettings.organizationId,
          set: { dealStages, taskTypes, updatedAt: new Date() },
        })
        .returning();

      return c.json({
        dealStages: saved?.dealStages ?? dealStages,
        taskTypes: saved?.taskTypes ?? taskTypes,
        usingDefaults: false,
      });
    },
  );

  /**
   * Deleting a tag, which the generic CRUD does not do safely.
   *
   * A tag is referenced by contacts, so removing the row alone leaves those
   * references pointing at nothing. This clears them in the same breath.
   */
  ctx.app.delete(
    "/api/crm/tags/:id",
    requireSession(),
    requirePermission({ crm: ["delete"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id");

      const [tag] = await db
        .select()
        .from(schema.tags)
        .where(
          and(eq(schema.tags.id, id), eq(schema.tags.organizationId, orgId)),
        )
        .limit(1);
      if (!tag) return c.json({ error: "not found" }, 404);

      // Tags attach through `taggables`, so removing the tag row alone would
      // leave rows pointing at nothing — which reads as a contact carrying a
      // tag that cannot be drawn.
      const attached = await db
        .delete(schema.taggables)
        .where(eq(schema.taggables.tagId, id))
        .returning({ id: schema.taggables.id });

      await db
        .delete(schema.tags)
        .where(
          and(eq(schema.tags.id, id), eq(schema.tags.organizationId, orgId)),
        );

      return c.json({ deleted: id, removedFrom: attached.length });
    },
  );
}
