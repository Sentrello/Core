import { randomBytes } from "node:crypto";
import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, schema } from "@sentrello/db";
import { lineTotals } from "@sentrello/db/money";
import { nextDocumentNumber } from "@sentrello/db/numbering";
import { defineModule } from "@sentrello/module-sdk";
import {
  HONEYPOT_FIELD,
  corsHeaders,
  looksAutomated,
  originAllowed,
  rateLimit,
} from "@sentrello/module-sdk";
import { embedScript } from "./loader";
import { problemPage, thanksPage, wantsHtml } from "./reply";

/** Per-form limit for public submissions. Generous for humans, hostile to bots. */
const SUBMIT_LIMIT = 5;
const SUBMIT_WINDOW_MS = 60_000;

const KIND = ["contact", "quote"] as const;

function newFormKey(): string {
  return `frm_${randomBytes(12).toString("base64url")}`;
}

export default defineModule({
  id: "forms",
  tier: "free",
  requires: ["crm"],
  register(ctx) {
    ctx.registerNav({
      id: "forms",
      label: "Forms",
      order: 25,
      group: "Configure",
    });
    for (const p of ["read", "create", "update", "delete"]) {
      ctx.registerPermission(`crm:${p}`);
    }

    // --- management (authenticated) ---

    ctx.app.get(
      "/api/forms",
      requireSession(),
      requirePermission({ crm: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const rows = await db
          .select()
          .from(schema.forms)
          .where(eq(schema.forms.organizationId, orgId));
        return c.json({ forms: rows });
      },
    );

    ctx.app.post(
      "/api/forms",
      requireSession(),
      requirePermission({ crm: ["create"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const body = await c.req.json();
        if (body.kind && !KIND.includes(body.kind)) {
          return c.json(
            { error: `kind must be one of ${KIND.join("|")}` },
            400,
          );
        }
        const [row] = await db
          .insert(schema.forms)
          .values({
            organizationId: orgId,
            key: newFormKey(),
            name: body.name ?? "Contact form",
            kind: body.kind ?? "contact",
            allowedOrigins: body.allowedOrigins ?? [],
            fields: body.fields ?? defaultFields(body.kind ?? "contact"),
            redirectUrl: body.redirectUrl,
            notifyEmail: body.notifyEmail,
          })
          .returning();
        return c.json({ form: row }, 201);
      },
    );

    ctx.app.patch(
      "/api/forms/:id",
      requireSession(),
      requirePermission({ crm: ["update"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const body = await c.req.json();
        const { organizationId: _o, id: _i, key: _k, ...patch } = body;
        const [row] = await db
          .update(schema.forms)
          .set(patch)
          .where(
            and(
              eq(schema.forms.id, c.req.param("id")),
              eq(schema.forms.organizationId, orgId),
            ),
          )
          .returning();
        if (!row) return c.json({ error: "not found" }, 404);
        return c.json({ form: row });
      },
    );

    ctx.app.get(
      "/api/forms/:id/submissions",
      requireSession(),
      requirePermission({ crm: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const rows = await db
          .select()
          .from(schema.formSubmissions)
          .where(
            and(
              eq(schema.formSubmissions.formId, c.req.param("id")),
              eq(schema.formSubmissions.organizationId, orgId),
            ),
          );
        return c.json({ submissions: rows });
      },
    );

    // --- public embed endpoints (no session, by design) ---

    /** Preflight for cross-site posts. */
    /**
     * The forms a business would otherwise have to invent.
     *
     * A new instance opens the Forms screen to nothing at all and has to guess
     * what a form is for and which fields belong on it. These are the two
     * every small business needs — somebody asking a question, and somebody
     * asking what a job would cost.
     *
     * Offered as a button in the empty state rather than created silently at
     * first run: a business that has deliberately deleted its forms should not
     * find them back tomorrow, and a screen that fills itself is harder to
     * understand than one that asks.
     */
    ctx.app.post(
      "/api/forms/defaults",
      requireSession(),
      requirePermission({ settings: ["update"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));

        const wanted = [
          {
            name: "Contact us",
            kind: "contact",
            tag: "contact",
            fields: [
              {
                name: "name",
                label: "Your name",
                type: "text",
                required: true,
              },
              { name: "email", label: "Email", type: "email", required: true },
              { name: "phone", label: "Phone", type: "tel" },
              { name: "message", label: "How can we help?", type: "textarea" },
            ],
          },
          {
            name: "Request a quote",
            kind: "quote",
            tag: "quote",
            fields: [
              {
                name: "name",
                label: "Your name",
                type: "text",
                required: true,
              },
              { name: "email", label: "Email", type: "email", required: true },
              { name: "phone", label: "Phone", type: "tel" },
              {
                name: "details",
                label: "What needs doing?",
                type: "textarea",
                required: true,
              },
            ],
          },
        ];

        const existing = await db
          .select({ name: schema.forms.name })
          .from(schema.forms)
          .where(eq(schema.forms.organizationId, orgId));
        const have = new Set(existing.map((f) => f.name.toLowerCase()));

        const made: string[] = [];
        for (const def of wanted) {
          if (have.has(def.name.toLowerCase())) continue;
          await db.insert(schema.forms).values({
            organizationId: orgId,
            key: crypto.randomUUID().replaceAll("-", "").slice(0, 20),
            name: def.name,
            kind: def.kind,
            tag: def.tag,
            fields: def.fields,
            // No origins listed means this site only, which is the safe
            // default for a form nobody has decided where to put yet.
            allowedOrigins: [],
          });
          made.push(def.name);
        }

        return c.json({ created: made });
      },
    );

    /**
     * Turn a submission into a deal.
     *
     * The submission already made a contact — that happens on the way in. What
     * it cannot do by itself is decide the enquiry is worth pursuing, which is
     * a judgement and therefore a button rather than an automatic step. A
     * pipeline that fills itself with every newsletter sign-up stops being
     * looked at.
     *
     * The form's tag becomes the deal's category, so "where did this come
     * from" survives into the pipeline rather than stopping at the contact.
     */
    ctx.app.post(
      "/api/forms/submissions/:id/promote",
      requireSession(),
      requirePermission({ crm: ["create"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const id = c.req.param("id");

        const [submission] = await db
          .select()
          .from(schema.formSubmissions)
          .where(
            and(
              eq(schema.formSubmissions.id, id),
              eq(schema.formSubmissions.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!submission) return c.json({ error: "not found" }, 404);
        if (!submission.contactId) {
          return c.json({ error: "this submission has no contact" }, 409);
        }

        const [form] = await db
          .select()
          .from(schema.forms)
          .where(eq(schema.forms.id, submission.formId))
          .limit(1);

        // Already promoted: return the deal rather than making a second one.
        // Somebody clicking twice should not end up with two identical deals
        // in the same column.
        const existing = await db
          .select()
          .from(schema.deals)
          .where(
            and(
              eq(schema.deals.organizationId, orgId),
              eq(schema.deals.sourceSubmissionId, id),
            ),
          )
          .limit(1);
        if (existing[0]) return c.json({ deal: existing[0], already: true });

        const payload = submission.payload ?? {};
        const summary =
          [payload.subject, payload.message, payload.details]
            .find((v) => typeof v === "string" && v.trim())
            ?.slice(0, 80) ??
          form?.name ??
          "Enquiry";

        const [deal] = await db
          .insert(schema.deals)
          .values({
            organizationId: orgId,
            name: summary,
            contactIds: [submission.contactId],
            stage: "opportunity",
            category: form?.tag ?? form?.name ?? null,
            description: Object.entries(payload)
              .map(([k, v]) => `${k}: ${v}`)
              .join("\n"),
            sourceSubmissionId: id,
          })
          .returning();

        return c.json({ deal }, 201);
      },
    );

    /**
     * The embed script itself.
     *
     * Public and unauthenticated by necessity — it runs on somebody else's
     * website, before anybody has filled anything in. It contains no data: the
     * form it renders is named by the tag that loaded it, and fetched at run
     * time, so one script serves every form on every instance.
     */
    ctx.app.get("/embed.js", (c) =>
      c.body(embedScript(), 200, {
        "content-type": "application/javascript; charset=utf-8",
        // Cached, but briefly. It changes when the product does, and a site
        // holding a month-old copy would miss a fix to the thing collecting
        // their leads.
        "cache-control": "public, max-age=3600",
        "access-control-allow-origin": "*",
      }),
    );

    ctx.app.options("/api/embed/forms/:key", async (c) => {
      const form = await formByKey(c.req.param("key"));
      const decision = originAllowed(
        c.req.header("origin"),
        form?.allowedOrigins ?? [],
      );
      if (!form || !decision.allowed) return c.body(null, 403);
      return c.body(null, 204, corsHeaders(decision.echo));
    });

    /** The form definition, so a snippet can render fields it did not hardcode. */
    ctx.app.get("/api/embed/forms/:key", async (c) => {
      const form = await formByKey(c.req.param("key"));
      const decision = originAllowed(
        c.req.header("origin"),
        form?.allowedOrigins ?? [],
      );
      if (!form || !form.active || !decision.allowed) {
        return c.json({ error: "not found" }, 404);
      }
      return c.json(
        {
          key: form.key,
          name: form.name,
          kind: form.kind,
          fields: form.fields,
          honeypot: HONEYPOT_FIELD,
          redirectUrl: form.redirectUrl,
          style: form.style ?? null,
        },
        200,
        corsHeaders(decision.echo),
      );
    });

    ctx.app.post("/api/embed/forms/:key", async (c) => {
      const key = c.req.param("key");
      const form = await formByKey(key);
      const origin = c.req.header("origin");
      const decision = originAllowed(origin, form?.allowedOrigins ?? []);

      // One 404 for "no such form", "inactive" and "origin not allowed": a
      // public endpoint should not help someone map which keys are real.
      if (!form || !form.active || !decision.allowed) {
        return wantsHtml(c)
          ? c.html(
              problemPage(
                "This form is no longer accepting messages. Try contacting the business another way.",
              ),
              404,
            )
          : c.json({ error: "not found" }, 404);
      }

      const limited = rateLimit(
        `${key}:${c.req.header("x-real-ip") ?? origin ?? "anon"}`,
        SUBMIT_LIMIT,
        SUBMIT_WINDOW_MS,
      );
      if (!limited.allowed) {
        const retry = { "retry-after": String(limited.retryAfterSeconds) };
        return wantsHtml(c)
          ? c.html(
              problemPage(
                "That is a lot of messages in a short time. Wait a minute and try again.",
              ),
              429,
              retry,
            )
          : c.json({ error: "too_many_requests" }, 429, {
              ...corsHeaders(decision.echo),
              ...retry,
            });
      }

      const payload = await readSubmission(c.req.raw);

      // Silent success for the honeypot: telling a bot it was detected only
      // teaches it to stop filling the trap.
      if (looksAutomated(payload)) {
        // The same reply a person gets, so a bot learns nothing from it.
        return wantsHtml(c)
          ? c.html(
              thanksPage(form.name, await businessName(form.organizationId)),
            )
          : c.json({ ok: true }, 202, corsHeaders(decision.echo));
      }

      const email = (payload.email ?? "").trim().toLowerCase();
      const name = (payload.name ?? "").trim();
      if (!name && !email) {
        return wantsHtml(c)
          ? c.html(
              problemPage(
                "Add your name or an email address so the business can reply, then send it again.",
              ),
              400,
            )
          : c.json(
              { error: "name or email is required" },
              400,
              corsHeaders(decision.echo),
            );
      }

      const orgId = form.organizationId;
      const contactId = await upsertContact(orgId, name, email, payload);

      let quoteId: string | undefined;
      if (form.kind === "quote") {
        quoteId = await draftQuote(orgId, contactId, payload);
      }

      const [submission] = await db
        .insert(schema.formSubmissions)
        .values({
          organizationId: orgId,
          formId: form.id,
          contactId,
          quoteId,
          payload,
          origin,
          userAgent: c.req.header("user-agent"),
        })
        .returning();

      // The submission itself is the record; an activity puts it on the
      // contact's timeline where a salesperson will actually see it.
      await db.insert(schema.activities).values({
        organizationId: orgId,
        contactId,
        type: "note",
        body: `${form.name}: ${summarise(payload)}`,
      });

      /**
       * A browser is sent somewhere; a script is told what happened.
       *
       * 303 rather than 302 so the visitor's browser follows with GET and a
       * refresh cannot post the message a second time.
       */
      if (wantsHtml(c)) {
        return form.redirectUrl
          ? c.redirect(form.redirectUrl, 303)
          : c.html(
              thanksPage(form.name, await businessName(form.organizationId)),
              201,
            );
      }

      return c.json(
        {
          ok: true,
          submissionId: submission?.id,
          redirectUrl: form.redirectUrl ?? null,
        },
        201,
        corsHeaders(decision.echo),
      );
    });
  },
});

/** The name on the thank-you page is the business's own, not Sentrello's. */
async function businessName(orgId: string): Promise<string> {
  const [org] = await db
    .select({ name: schema.organizations.name })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId))
    .limit(1);
  return org?.name ?? "the business";
}

async function formByKey(key: string) {
  const [form] = await db
    .select()
    .from(schema.forms)
    .where(eq(schema.forms.key, key))
    .limit(1);
  return form;
}

/** Accepts JSON or a plain HTML form post, so a snippet needs no JavaScript. */
async function readSubmission(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = await req.json().catch(() => ({}));
    return Object.fromEntries(
      Object.entries(body as Record<string, unknown>).map(([k, v]) => [
        k,
        String(v ?? ""),
      ]),
    );
  }
  const form = await req.formData().catch(() => new FormData());
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) out[k] = String(v);
  return out;
}

/**
 * A typed name, split the way the CRM stores one.
 *
 * A form asks for "your name" in one box, because asking a stranger on a
 * website for two is a box more than they will fill in. The CRM keeps first
 * and last separately, so a lead arriving from the website opened with both
 * fields blank while the list showed its name — the same person recorded two
 * different ways depending on which screen you were looking at.
 *
 * First word, then the rest. A single word stays a first name rather than
 * being forced into a surname nobody gave: plenty of people have one name.
 */
export function splitName(full: string): {
  firstName: string | null;
  lastName: string | null;
} {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: null };
  const [first, ...rest] = parts;
  return {
    firstName: first ?? null,
    lastName: rest.length > 0 ? rest.join(" ") : null,
  };
}

/** One contact per email address: a repeat enquiry should not create a duplicate. */
async function upsertContact(
  orgId: string,
  name: string,
  email: string,
  payload: Record<string, string>,
): Promise<string> {
  if (email) {
    const [existing] = await db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.organizationId, orgId),
          eq(schema.contacts.email, email),
        ),
      )
      .limit(1);
    if (existing) return existing.id;
  }

  const [created] = await db
    .insert(schema.contacts)
    .values({
      organizationId: orgId,
      // Both: `name` is what quotes, invoices and the portal read, and the
      // split is what the CRM's own screens edit.
      name: name || email || "Website enquiry",
      ...splitName(name),
      email: email || null,
      phone: payload.phone ?? null,
      kind: "lead",
    })
    .returning();
  if (!created) throw new Error("contact insert returned no row");
  return created.id;
}

/** A quote request becomes a draft quote for someone to price up. */
async function draftQuote(
  orgId: string,
  contactId: string,
  payload: Record<string, string>,
): Promise<string> {
  const totals = lineTotals([]);
  const quote = await db.transaction(async (tx) => {
    const [q] = await tx
      .insert(schema.quotes)
      .values({
        organizationId: orgId,
        contactId,
        number: await nextDocumentNumber(tx, orgId, "quote"),
        status: "draft",
        subtotalCents: totals.subtotal,
        taxCents: totals.tax,
        totalCents: totals.total,
      })
      .returning();
    if (!q) throw new Error("quote insert returned no row");

    // Whatever they described becomes the first line, at zero, for pricing.
    const description = payload.message ?? payload.details ?? "Quote request";
    await tx.insert(schema.quoteLines).values({
      quoteId: q.id,
      description: description.slice(0, 500),
      quantity: 1,
      unitPriceCents: 0,
      taxRateBp: 0,
    });
    return q;
  });
  return quote.id;
}

function summarise(payload: Record<string, string>): string {
  return Object.entries(payload)
    .filter(([k]) => k !== HONEYPOT_FIELD)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ")
    .slice(0, 1000);
}

function defaultFields(kind: string) {
  const base = [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "email", label: "Email", type: "email", required: true },
    { name: "phone", label: "Phone", type: "tel" },
  ];
  return kind === "quote"
    ? [
        ...base,
        {
          name: "message",
          label: "What do you need a quote for?",
          type: "textarea",
          required: true,
        },
      ]
    : [...base, { name: "message", label: "Message", type: "textarea" }];
}
