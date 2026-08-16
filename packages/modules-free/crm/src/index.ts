import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import { defineModule } from "@sentrello/module-sdk";
import { and, desc, eq } from "drizzle-orm";
import { registerAttachments } from "./attachments";

/**
 * Org-scoped CRUD for one table. Every query carries the organizationId filter
 * — a business query without it is a cross-tenant leak, so the filter lives
 * here once rather than in each route.
 */
/**
 * Dates arrive as strings, because JSON has no date type.
 *
 * Drizzle hands a timestamp column straight to the driver, which calls
 * `.toISOString()` on it — so a perfectly ordinary ISO string became
 * `value.toISOString is not a function` and a 500. Every client sending a date
 * hit this, since there is no other way to send one.
 *
 * Converted where the column is a timestamp, and refused with a 400 when it is
 * not a date at all. Anything else is left alone.
 */
const TIMESTAMP_FIELDS = new Set([
  "occurredAt",
  "dueAt",
  "completedAt",
  "startsAt",
  "endsAt",
]);

function withParsedDates(
  body: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; field: string } {
  const out: Record<string, unknown> = { ...body };
  for (const field of TIMESTAMP_FIELDS) {
    const raw = out[field];
    if (raw === undefined) continue;
    if (raw === null || raw === "") {
      out[field] = null;
      continue;
    }
    if (raw instanceof Date) continue;
    const parsed = new Date(String(raw));
    if (Number.isNaN(parsed.getTime())) return { ok: false, field };
    out[field] = parsed;
  }
  return { ok: true, value: out };
}

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
      const parsed = withParsedDates(body);
      if (!parsed.ok) {
        return c.json({ error: `${parsed.field} is not a date` }, 400);
      }
      if (resource === "contacts") {
        const name = displayName(parsed.value);
        if (name) parsed.value.name = name;
      }
      const [row] = await db
        .insert(table)
        .values({ ...parsed.value, organizationId: orgId })
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
      const { organizationId: _ignored, id: _id, ...rest } = body;
      const parsed = withParsedDates(rest);
      if (!parsed.ok) {
        return c.json({ error: `${parsed.field} is not a date` }, 400);
      }
      if (resource === "contacts") {
        const name = displayName(parsed.value);
        if (name) parsed.value.name = name;
      }
      const [row] = await db
        .update(table)
        .set(parsed.value)
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
  deals: {
    table: schema.deals,
    path: "deals",
    singular: "deal",
    permission: "crm",
  },
  notes: {
    table: schema.notes,
    path: "notes",
    singular: "note",
    permission: "crm",
  },
} as const;

/**
 * A contact's display name, always first + last.
 *
 * Written on every save rather than computed on read, because invoices,
 * quotes and the customer portal select `name` directly — and an invoice
 * addressed to an empty string because somebody edited a surname is not a
 * failure anyone would connect back to the CRM.
 */
export function displayName(body: Record<string, unknown>): string | undefined {
  const first = typeof body.firstName === "string" ? body.firstName.trim() : "";
  const last = typeof body.lastName === "string" ? body.lastName.trim() : "";
  const joined = [first, last].filter(Boolean).join(" ");
  if (joined) return joined;
  // Neither name given: leave whatever `name` was sent alone, so a contact
  // recorded as a single string — which is most of them, historically — is not
  // wiped by an edit that never mentioned it.
  return typeof body.name === "string" ? body.name : undefined;
}

/**
 * The kanban, and everything a contact is attached to.
 *
 * Registered by hand rather than through `crud` because neither is a row
 * operation: one reorders a column, the other answers a question that spans
 * five tables.
 */
function registerCrmScreens(
  ctx: Parameters<Parameters<typeof defineModule>[0]["register"]>[0],
) {
  /**
   * Bring a spreadsheet of contacts in.
   *
   * The rows arrive already mapped to our field names — the mapping happens on
   * the screen, where somebody can see their own column headings. This end
   * only has to be careful about what it writes.
   *
   * Companies are matched by name and created when missing, because a
   * spreadsheet says "Ellesmere Dental", not a uuid, and asking somebody to
   * create thirty companies before importing their contacts is the reason the
   * import never happens.
   */
  ctx.app.post(
    "/api/contacts/import",
    requireSession(),
    requirePermission({ crm: ["create"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as {
        rows?: Record<string, string>[];
      };
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (rows.length === 0) return c.json({ error: "nothing to import" }, 400);
      // A cap, because this runs in one request and a hundred thousand rows
      // would hold a connection open long enough to look like a hang.
      if (rows.length > 5000) {
        return c.json({ error: "too many rows; split the file" }, 413);
      }

      const existingCompanies = await db
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.organizationId, orgId));
      const byName = new Map(
        existingCompanies.map((co) => [co.name.trim().toLowerCase(), co.id]),
      );

      let imported = 0;
      let companiesCreated = 0;
      const skipped: { row: number; why: string }[] = [];

      for (const [index, raw] of rows.entries()) {
        const firstName = (raw.firstName ?? "").trim();
        const lastName = (raw.lastName ?? "").trim();
        const name = [firstName, lastName].filter(Boolean).join(" ");
        if (!name) {
          // Nameless rows are the blank lines at the bottom of every
          // spreadsheet. Reported rather than silently dropped.
          skipped.push({ row: index + 2, why: "no name" });
          continue;
        }

        let companyId: string | null = null;
        const companyName = (raw.company ?? "").trim();
        if (companyName) {
          const key = companyName.toLowerCase();
          const found = byName.get(key);
          if (found) {
            companyId = found;
          } else {
            const [made] = await db
              .insert(schema.companies)
              .values({ organizationId: orgId, name: companyName })
              .returning();
            if (made) {
              companyId = made.id;
              byName.set(key, made.id);
              companiesCreated += 1;
            }
          }
        }

        await db.insert(schema.contacts).values({
          organizationId: orgId,
          name,
          firstName: firstName || null,
          lastName: lastName || null,
          title: (raw.title ?? "").trim() || null,
          email: (raw.email ?? "").trim() || null,
          phone: (raw.phone ?? "").trim() || null,
          linkedinUrl: (raw.linkedinUrl ?? "").trim() || null,
          companyId,
        });
        imported += 1;
      }

      return c.json({ imported, companiesCreated, skipped });
    },
  );

  /**
   * Contacts and companies, as a spreadsheet.
   *
   * A trial that begins with an empty CRM and a re-typing job is a trial that
   * ends — so getting data out matters as much as getting it in, and it is
   * also how somebody checks an import went the way they expected.
   */
  ctx.app.get(
    "/api/contacts/export.csv",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [rows, allCompanies] = await Promise.all([
        db
          .select()
          .from(schema.contacts)
          .where(eq(schema.contacts.organizationId, orgId)),
        db
          .select()
          .from(schema.companies)
          .where(eq(schema.companies.organizationId, orgId)),
      ]);
      const companyName = new Map(allCompanies.map((co) => [co.id, co.name]));

      const csv = toCsv(
        [
          "First name",
          "Last name",
          "Job title",
          "Company",
          "Email",
          "Phone",
          "Other emails",
          "Other phones",
          "LinkedIn",
        ],
        rows.map((r) => [
          r.firstName ?? "",
          r.lastName ?? "",
          r.title ?? "",
          // The company's name, not its id. A spreadsheet full of uuids is not
          // something anybody can read, edit or import elsewhere.
          r.companyId ? (companyName.get(r.companyId) ?? "") : "",
          r.email ?? "",
          r.phone ?? "",
          (r.emails ?? []).map((e) => `${e.label}: ${e.value}`).join("; "),
          (r.phones ?? []).map((e) => `${e.label}: ${e.value}`).join("; "),
          r.linkedinUrl ?? "",
        ]),
      );

      return c.body(csv, 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="contacts.csv"',
      });
    },
  );

  ctx.app.get(
    "/api/companies/export.csv",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.organizationId, orgId));

      const csv = toCsv(
        [
          "Name",
          "Sector",
          "People",
          "Phone",
          "Website",
          "Address",
          "City",
          "Country",
          "Description",
        ],
        rows.map((r) => [
          r.name,
          r.sector ?? "",
          r.size ?? "",
          r.phone ?? "",
          r.website ?? "",
          r.address ?? "",
          r.city ?? "",
          r.country ?? "",
          r.description ?? "",
        ]),
      );

      return c.body(csv, 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="companies.csv"',
      });
    },
  );

  /**
   * Move a deal: which column, and where in it.
   *
   * Position and stage together in one call, because dragging a card is one
   * action to the person doing it. Two calls would leave a card that had
   * changed column but not order if the second failed.
   */
  ctx.app.patch(
    "/api/deals/:id/move",
    requireSession(),
    requirePermission({ crm: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as {
        stage?: string;
        position?: number;
      };

      const stage = typeof body.stage === "string" ? body.stage : undefined;
      const position =
        typeof body.position === "number" && Number.isFinite(body.position)
          ? Math.max(0, Math.trunc(body.position))
          : undefined;
      if (!stage && position === undefined) {
        return c.json({ error: "a stage or a position is required" }, 400);
      }

      const [row] = await db
        .update(schema.deals)
        .set({
          ...(stage ? { stage } : {}),
          ...(position === undefined ? {} : { position }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.deals.id, c.req.param("id")),
            eq(schema.deals.organizationId, orgId),
          ),
        )
        .returning();
      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({ deal: row });
    },
  );

  /**
   * Put a tag on something, or take it off.
   *
   * `taggables` carries no organizationId of its own — it is scoped through
   * the tag it points at. So the tag is checked against the session's
   * organisation before anything is written, or one business could label
   * another's records by guessing an id.
   */
  // Registered per entity rather than with one clever pattern. The pattern was
  // `:entityType{contact|company|deal}s`, which is not valid Hono and took the
  // whole router down with it — every route in the module 500'd, not just
  // these. Three plain paths cost nothing and cannot do that.
  for (const [plural, entityType] of [
    ["contacts", "contact"],
    ["companies", "company"],
    ["deals", "deal"],
  ] as const) {
    ctx.app.post(
      `/api/${plural}/:id/tags`,
      requireSession(),
      requirePermission({ crm: ["update"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const entityId = c.req.param("id");
        const body = (await c.req.json().catch(() => ({}))) as {
          tagId?: string;
        };
        if (!body.tagId) return c.json({ error: "a tagId is required" }, 400);

        const [tag] = await db
          .select()
          .from(schema.tags)
          .where(
            and(
              eq(schema.tags.id, body.tagId),
              eq(schema.tags.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!tag) return c.json({ error: "no such tag" }, 404);

        // Tagging something twice is not an error — somebody clicked twice, and
        // a duplicate row would show the same label on the record twice.
        const [existing] = await db
          .select()
          .from(schema.taggables)
          .where(
            and(
              eq(schema.taggables.tagId, tag.id),
              eq(schema.taggables.entityType, entityType),
              eq(schema.taggables.entityId, entityId),
            ),
          )
          .limit(1);
        if (existing) return c.json({ tag });

        await db
          .insert(schema.taggables)
          .values({ tagId: tag.id, entityType, entityId });
        return c.json({ tag }, 201);
      },
    );

    ctx.app.delete(
      `/api/${plural}/:id/tags/:tagId`,
      requireSession(),
      requirePermission({ crm: ["update"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));

        // Same check on the way out: without it, a guessed tag id would detach
        // a label from another business's record.
        const [tag] = await db
          .select()
          .from(schema.tags)
          .where(
            and(
              eq(schema.tags.id, c.req.param("tagId")),
              eq(schema.tags.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!tag) return c.json({ error: "no such tag" }, 404);

        await db
          .delete(schema.taggables)
          .where(
            and(
              eq(schema.taggables.tagId, tag.id),
              eq(schema.taggables.entityType, entityType),
              eq(schema.taggables.entityId, c.req.param("id")),
            ),
          );
        return c.body(null, 204);
      },
    );
  }

  /**
   * One deal, and who it involves.
   *
   * The board links here, so without it every card is a dead end — the same
   * problem a contact's company link had before companies got a screen.
   */
  ctx.app.get(
    "/api/deals/:id/related",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id");

      const [deal] = await db
        .select()
        .from(schema.deals)
        .where(
          and(eq(schema.deals.id, id), eq(schema.deals.organizationId, orgId)),
        )
        .limit(1);
      if (!deal) return c.json({ error: "not found" }, 404);

      const [company, everyone, notes] = await Promise.all([
        deal.companyId
          ? db
              .select()
              .from(schema.companies)
              .where(
                and(
                  eq(schema.companies.id, deal.companyId),
                  eq(schema.companies.organizationId, orgId),
                ),
              )
              .limit(1)
          : Promise.resolve([]),
        // The deal names its contacts in a jsonb array, so they are gathered
        // here rather than joined. Same trade as the contact screen, same
        // reason: a business under twenty staff will never notice.
        db
          .select()
          .from(schema.contacts)
          .where(eq(schema.contacts.organizationId, orgId)),
        db
          .select()
          .from(schema.notes)
          .where(
            and(
              eq(schema.notes.organizationId, orgId),
              eq(schema.notes.entityType, "deal"),
              eq(schema.notes.entityId, id),
            ),
          )
          .orderBy(desc(schema.notes.createdAt)),
      ]);

      const on = new Set(deal.contactIds ?? []);
      return c.json({
        deal,
        company: company[0] ?? null,
        contacts: everyone.filter((p) => on.has(p.id)),
        notes,
      });
    },
  );

  /**
   * One company, and who and what belongs to it.
   *
   * The other half of the same idea. A contact's company link is only worth
   * following if there is something on the other side — the people who work
   * there and the deals in flight, which is the view a business actually wants
   * before a meeting.
   */
  ctx.app.get(
    "/api/companies/:id/related",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id");

      const [company] = await db
        .select()
        .from(schema.companies)
        .where(
          and(
            eq(schema.companies.id, id),
            eq(schema.companies.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!company) return c.json({ error: "not found" }, 404);

      const [people, deals, notes] = await Promise.all([
        db
          .select()
          .from(schema.contacts)
          .where(
            and(
              eq(schema.contacts.organizationId, orgId),
              eq(schema.contacts.companyId, id),
            ),
          ),
        db
          .select()
          .from(schema.deals)
          .where(
            and(
              eq(schema.deals.organizationId, orgId),
              eq(schema.deals.companyId, id),
            ),
          ),
        db
          .select()
          .from(schema.notes)
          .where(
            and(
              eq(schema.notes.organizationId, orgId),
              eq(schema.notes.entityType, "company"),
              eq(schema.notes.entityId, id),
            ),
          )
          .orderBy(desc(schema.notes.createdAt)),
      ]);

      return c.json({ company, contacts: people, deals, notes });
    },
  );

  /**
   * One contact, and everything it connects to.
   *
   * The whole point of the rework: a contact that cannot show its deals, notes
   * and tasks is a row in a table, and the application reads as unrelated
   * parts because that is what it serves.
   */
  ctx.app.get(
    "/api/contacts/:id/related",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id");

      const [contact] = await db
        .select()
        .from(schema.contacts)
        .where(
          and(
            eq(schema.contacts.id, id),
            eq(schema.contacts.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!contact) return c.json({ error: "not found" }, 404);

      const [company, notes, tasks, tagRows, allDeals] = await Promise.all([
        contact.companyId
          ? db
              .select()
              .from(schema.companies)
              .where(
                and(
                  eq(schema.companies.id, contact.companyId),
                  eq(schema.companies.organizationId, orgId),
                ),
              )
              .limit(1)
          : Promise.resolve([]),
        db
          .select()
          .from(schema.notes)
          .where(
            and(
              eq(schema.notes.organizationId, orgId),
              eq(schema.notes.entityType, "contact"),
              eq(schema.notes.entityId, id),
            ),
          )
          .orderBy(desc(schema.notes.createdAt)),
        db
          .select()
          .from(schema.tasks)
          .where(
            and(
              eq(schema.tasks.organizationId, orgId),
              eq(schema.tasks.contactId, id),
            ),
          ),
        db
          .select({ tag: schema.tags })
          .from(schema.taggables)
          .innerJoin(schema.tags, eq(schema.taggables.tagId, schema.tags.id))
          .where(
            and(
              eq(schema.taggables.entityType, "contact"),
              eq(schema.taggables.entityId, id),
              eq(schema.tags.organizationId, orgId),
            ),
          ),
        // Deals hold their contacts in a jsonb array, so the filter happens
        // here rather than in SQL. Fine at the scale this product targets —
        // under twenty staff — and honest about it rather than pretending a
        // clever query exists.
        // ponytail: scan-and-filter; move to a join table if a business ever
        // has enough deals for this to show.
        db
          .select()
          .from(schema.deals)
          .where(eq(schema.deals.organizationId, orgId)),
      ]);

      return c.json({
        contact,
        company: company[0] ?? null,
        deals: allDeals.filter((d) => (d.contactIds ?? []).includes(id)),
        notes,
        tasks,
        tags: tagRows.map((r) => r.tag),
      });
    },
  );
}

/**
 * One CSV field.
 *
 * Quoted whenever it contains a comma, a quote or a newline, with inner quotes
 * doubled — the rules every spreadsheet expects. A note reading `Called, no
 * answer` becomes two columns without this, and the whole file shifts by one
 * from that row down.
 */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvField).join(",")];
  for (const row of rows) lines.push(row.map(csvField).join(","));
  // CRLF, because Excel treats a bare newline as part of the field on some
  // platforms and the file opens as one long row.
  return `${lines.join("\r\n")}\r\n`;
}

export default defineModule({
  id: "crm",
  tier: "free",
  register(ctx) {
    ctx.registerNav({
      id: "crm",
      label: "Contacts",
      order: 10,
      group: "Sales",
      // The book of customers is not everybody's to open.
      requires: { crm: ["read"] },
    });
    ctx.registerNav({
      id: "companies",
      label: "Companies",
      order: 11,
      group: "Sales",
      requires: { crm: ["read"] },
    });
    // The pipeline. Named Deals as Atomic CRM has it; the quote-to-payment
    // flow is Make Deal, which is a different thing that used to share a name.
    ctx.registerNav({
      id: "deals",
      label: "Deals",
      order: 12,
      group: "Sales",
      requires: { crm: ["read"] },
    });
    for (const p of ["read", "create", "update", "delete"]) {
      ctx.registerPermission(`crm:${p}`);
    }
    for (const resource of Object.keys(tables) as (keyof typeof tables)[]) {
      crud(ctx, resource);
    }
    registerCrmScreens(ctx);
    registerAttachments(ctx);
  },
});
