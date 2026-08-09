import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import { defineModule } from "@sentrello/module-sdk";
import { and, eq } from "drizzle-orm";

/**
 * Org-scoped CRUD for one table. Every query carries the organizationId filter
 * — a business query without it is a cross-tenant leak, so the filter lives
 * here once rather than in each route.
 */
function crud<T extends keyof typeof tables>(
  ctx: Parameters<Parameters<typeof defineModule>[0]["register"]>[0],
  resource: T,
) {
  const { table, path, singular, permission } = tables[resource];

  ctx.app.get(
    `/api/${path}`,
    requireSession(),
    requirePermission({ [permission]: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select()
        .from(table)
        .where(eq(table.organizationId, orgId));
      return c.json({ [path]: rows });
    },
  );

  ctx.app.post(
    `/api/${path}`,
    requireSession(),
    requirePermission({ [permission]: ["create"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = await c.req.json();
      const [row] = await db
        .insert(table)
        .values({ ...body, organizationId: orgId })
        .returning();
      return c.json({ [singular]: row }, 201);
    },
  );

  ctx.app.patch(
    `/api/${path}/:id`,
    requireSession(),
    requirePermission({ [permission]: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = await c.req.json();
      // organizationId is never taken from the body — it comes from the session
      const { organizationId: _ignored, id: _id, ...patch } = body;
      const [row] = await db
        .update(table)
        .set(patch)
        .where(
          and(eq(table.id, c.req.param("id")), eq(table.organizationId, orgId)),
        )
        .returning();
      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({ [singular]: row });
    },
  );

  ctx.app.delete(
    `/api/${path}/:id`,
    requireSession(),
    requirePermission({ [permission]: ["delete"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [row] = await db
        .delete(table)
        .where(
          and(eq(table.id, c.req.param("id")), eq(table.organizationId, orgId)),
        )
        .returning();
      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({ deleted: row.id });
    },
  );
}

const tables = {
  contacts: {
    table: schema.contacts,
    path: "contacts",
    singular: "contact",
    permission: "crm",
  },
  companies: {
    table: schema.companies,
    path: "companies",
    singular: "company",
    permission: "crm",
  },
  activities: {
    table: schema.activities,
    path: "activities",
    singular: "activity",
    permission: "crm",
  },
  tasks: {
    table: schema.tasks,
    path: "tasks",
    singular: "task",
    permission: "crm",
  },
  tags: {
    table: schema.tags,
    path: "tags",
    singular: "tag",
    permission: "crm",
  },
} as const;

export default defineModule({
  id: "crm",
  tier: "free",
  register(ctx) {
    ctx.registerNav({ id: "crm", label: "Contacts", order: 10 });
    for (const p of ["read", "create", "update", "delete"]) {
      ctx.registerPermission(`crm:${p}`);
    }
    for (const resource of Object.keys(tables) as (keyof typeof tables)[]) {
      crud(ctx, resource);
    }
  },
});
