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
  const blocksDelete = (
    tables[resource] as {
      blocksDelete?: (orgId: string, id: string) => Promise<string | null>;
    }
  ).blocksDelete;

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

      // Nothing here is protected by a foreign key, so a delete that should be
      // refused would instead succeed and quietly orphan the rows pointing at
      // it — an invoice with no customer, a portal link that stops working.
      if (blocksDelete) {
        const reason = await blocksDelete(orgId, c.req.param("id"));
        if (reason) return c.json({ error: reason }, 409);
      }

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
    /**
     * A customer with financial history is not deletable.
     *
     * Their invoices would keep working but stop naming anyone, and the ledger
     * would still carry the money — the business would be left with revenue it
     * cannot attribute. Refusing is recoverable; deleting is not.
     */
    async blocksDelete(orgId: string, id: string) {
      const [invoices, quotes] = await Promise.all([
        db
          .select({ id: schema.invoices.id })
          .from(schema.invoices)
          .where(
            and(
              eq(schema.invoices.organizationId, orgId),
              eq(schema.invoices.contactId, id),
            ),
          ),
        db
          .select({ id: schema.quotes.id })
          .from(schema.quotes)
          .where(
            and(
              eq(schema.quotes.organizationId, orgId),
              eq(schema.quotes.contactId, id),
            ),
          ),
      ]);

      const parts: string[] = [];
      if (invoices.length) {
        parts.push(
          `${invoices.length} invoice${invoices.length > 1 ? "s" : ""}`,
        );
      }
      if (quotes.length) {
        parts.push(`${quotes.length} quote${quotes.length > 1 ? "s" : ""}`);
      }
      return parts.length
        ? `This customer has ${parts.join(" and ")}. Deleting them would leave those without a customer.`
        : null;
    },
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
