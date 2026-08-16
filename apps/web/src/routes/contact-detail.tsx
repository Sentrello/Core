import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import {
  LabelledList,
  type Labelled as ListRow,
  tidy,
  withBlank,
} from "../lib/labelled-list";
import { RelatedLink, useNavigation } from "../lib/navigation";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  Select,
  formatDate,
  formatMoney,
  muted,
} from "../lib/ui";

/**
 * One contact, and everything attached to it.
 *
 * This screen is the answer to "you cannot tell what connects to what". A
 * contact is not a row in a table — it is a company, a pile of deals, the
 * notes somebody wrote after a phone call, and the follow-up nobody has done
 * yet. Showing those together is the difference between a database with a form
 * on it and a CRM.
 */

interface Labelled {
  label: string;
  value: string;
}

interface Related {
  contact: {
    id: string;
    name: string;
    firstName: string | null;
    lastName: string | null;
    title: string | null;
    email: string | null;
    phone: string | null;
    emails: Labelled[] | null;
    phones: Labelled[] | null;
    linkedinUrl: string | null;
    companyId: string | null;
  };
  company: { id: string; name: string } | null;
  deals: {
    id: string;
    name: string;
    stage: string;
    amountCents: number;
    expectedCloseOn: string | null;
  }[];
  notes: {
    id: string;
    text: string;
    createdAt: string;
    attachments: { name: string; path: string; size: number }[] | null;
  }[];
  tasks: { id: string; title: string; dueAt: string | null; done: boolean }[];
  tags: { id: string; name: string; color: string }[];
}

/** Every way to reach somebody, first-class column and labelled list together. */
function ways(primary: string | null, rest: Labelled[] | null): Labelled[] {
  const out: Labelled[] = primary ? [{ label: "main", value: primary }] : [];
  for (const item of rest ?? []) {
    // The primary is often repeated in the list; showing it twice looks like
    // a data problem to the person reading it.
    if (item.value && item.value !== primary) out.push(item);
  }
  return out;
}

/**
 * Correcting the record.
 *
 * A CRM you cannot fix a phone number in is worse than one missing a bulk
 * importer: the wrong number is used, an invoice goes to the wrong address, and
 * the only remedy is deleting the contact and losing everything attached to it.
 */
function EditContact({
  contact,
  onDone,
}: {
  contact: Related["contact"];
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    firstName: contact.firstName ?? "",
    lastName: contact.lastName ?? "",
    title: contact.title ?? "",
    email: contact.email ?? "",
    phone: contact.phone ?? "",
    linkedinUrl: contact.linkedinUrl ?? "",
    companyId: contact.companyId ?? "",
  });
  const [emails, setEmails] = useState<ListRow[]>(withBlank(contact.emails));
  const [phones, setPhones] = useState<ListRow[]>(withBlank(contact.phones));

  const companies = useQuery({
    queryKey: ["companies"],
    queryFn: () =>
      api<{ companies: { id: string; name: string }[] }>("/api/companies"),
  });

  const save = useMutation({
    mutationFn: () =>
      api(`/api/contacts/${contact.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...form,
          // Empty strings would overwrite a real value with nothing; null is
          // how you say "there isn't one".
          title: form.title || null,
          email: form.email || null,
          phone: form.phone || null,
          linkedinUrl: form.linkedinUrl || null,
          companyId: form.companyId || null,
          emails: tidy(emails),
          phones: tidy(phones),
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact-related", contact.id] });
      // The list shows the display name, which first and last just changed.
      qc.invalidateQueries({ queryKey: ["contacts"] });
      // The company screen lists who works there, and this may have just
      // moved somebody in or out.
      qc.invalidateQueries({ queryKey: ["company-related"] });
      onDone();
    },
  });

  const set = (patch: Partial<typeof form>) =>
    setForm((f) => ({ ...f, ...patch }));

  return (
    <Card>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="First name">
          <Input
            value={form.firstName}
            onChange={(e) => set({ firstName: e.target.value })}
          />
        </Field>
        <Field label="Last name">
          <Input
            value={form.lastName}
            onChange={(e) => set({ lastName: e.target.value })}
          />
        </Field>
        <Field label="Job title">
          <Input
            value={form.title}
            onChange={(e) => set({ title: e.target.value })}
          />
        </Field>
        <Field label="LinkedIn">
          <Input
            value={form.linkedinUrl}
            onChange={(e) => set({ linkedinUrl: e.target.value })}
          />
        </Field>
        <Field label="Main email" hint="The one invoices and reminders use.">
          <Input
            value={form.email}
            onChange={(e) => set({ email: e.target.value })}
          />
        </Field>
        <Field label="Main phone">
          <Input
            value={form.phone}
            onChange={(e) => set({ phone: e.target.value })}
          />
        </Field>
        <Field label="Company" hint="Who they work for, if anyone.">
          <Select
            value={form.companyId}
            onChange={(e) => set({ companyId: e.target.value })}
          >
            <option value="">No company</option>
            {(companies.data?.companies ?? []).map((co) => (
              <option key={co.id} value={co.id}>
                {co.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Other emails">
          <LabelledList
            rows={emails}
            onChange={setEmails}
            placeholder="email"
          />
        </Field>
        <Field label="Other phones">
          <LabelledList
            rows={phones}
            onChange={setPhones}
            placeholder="phone"
          />
        </Field>
      </div>

      <div className="mt-3 flex gap-2">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <button
          type="button"
          className="text-sm underline"
          style={muted}
          onClick={onDone}
        >
          Cancel
        </button>
      </div>
      {save.error ? <ErrorNote error={save.error} /> : null}
    </Card>
  );
}

/**
 * A colour for a new tag, from a small readable set.
 *
 * Tags are scanned rather than read, so they need to differ at a glance —
 * and asking somebody to pick a hex code before they can label a contact is
 * a worse first experience than choosing for them.
 */
const TAG_COLOURS = [
  "#22c55e",
  "#3b82f6",
  "#f59e0b",
  "#ef4444",
  "#a855f7",
  "#14b8a6",
];
function randomTagColour(): string {
  return TAG_COLOURS[Math.floor(Math.random() * TAG_COLOURS.length)] as string;
}

function Tags({
  contactId,
  attached,
}: {
  contactId: string;
  attached: Related["tags"];
}) {
  const qc = useQueryClient();
  const [picking, setPicking] = useState(false);
  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["contact-related", contactId] });

  const all = useQuery({
    queryKey: ["tags"],
    queryFn: () => api<{ tags: Related["tags"] }>("/api/tags"),
    enabled: picking,
  });

  // Creating a tag where it is needed. The picker used to say "create them
  // under Tags", which is a screen that does not exist — so the only way to
  // make one was the API.
  const [newName, setNewName] = useState("");
  const create = useMutation({
    mutationFn: async () => {
      const made = await api<{ tag: { id: string } }>("/api/tags", {
        method: "POST",
        body: JSON.stringify({ name: newName, color: randomTagColour() }),
      });
      await api(`/api/contacts/${contactId}/tags`, {
        method: "POST",
        body: JSON.stringify({ tagId: made.tag.id }),
      });
    },
    onSuccess: () => {
      setNewName("");
      setPicking(false);
      qc.invalidateQueries({ queryKey: ["tags"] });
      refresh();
    },
  });

  const attach = useMutation({
    mutationFn: (tagId: string) =>
      api(`/api/contacts/${contactId}/tags`, {
        method: "POST",
        body: JSON.stringify({ tagId }),
      }),
    onSuccess: () => {
      setPicking(false);
      refresh();
    },
  });

  const detach = useMutation({
    mutationFn: (tagId: string) =>
      api(`/api/contacts/${contactId}/tags/${tagId}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  const on = new Set(attached.map((t) => t.id));
  const available = (all.data?.tags ?? []).filter((t) => !on.has(t.id));

  return (
    <div className="flex flex-wrap items-center gap-1">
      {attached.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => detach.mutate(t.id)}
          title="Remove"
          className="rounded-full px-2 py-0.5 text-xs"
          style={{ background: t.color, color: "#111" }}
        >
          {t.name} ×
        </button>
      ))}

      <button
        type="button"
        onClick={() => setPicking((v) => !v)}
        className="rounded-full border px-2 py-0.5 text-xs"
        style={{ borderColor: "var(--border)", ...muted }}
      >
        {picking ? "Cancel" : "+ Tag"}
      </button>

      {picking ? (
        available.length ? (
          <div className="flex flex-wrap gap-1">
            {available.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => attach.mutate(t.id)}
                className="rounded-full px-2 py-0.5 text-xs"
                style={{ background: t.color, color: "#111", opacity: 0.75 }}
              >
                {t.name}
              </button>
            ))}
          </div>
        ) : null
      ) : null}

      {picking ? (
        <div className="flex items-center gap-1">
          <Input
            value={newName}
            placeholder="New tag"
            aria-label="New tag name"
            className="w-32"
            onChange={(e) => setNewName(e.target.value)}
          />
          <Button
            onClick={() => create.mutate()}
            disabled={!newName.trim() || create.isPending}
          >
            {create.isPending ? "…" : "Create"}
          </Button>
        </div>
      ) : null}
      {create.error ? <ErrorNote error={create.error} /> : null}
    </div>
  );
}

function FollowUps({
  contactId,
  tasks,
}: {
  contactId: string;
  tasks: Related["tasks"];
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["contact-related", contactId] });

  const add = useMutation({
    mutationFn: () =>
      api("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          title,
          contactId,
          // An empty date field must not become an invalid one.
          ...(due ? { dueAt: new Date(due).toISOString() } : {}),
        }),
      }),
    onSuccess: () => {
      setTitle("");
      setDue("");
      refresh();
    },
  });

  const toggle = useMutation({
    mutationFn: ({ id, done }: { id: string; done: boolean }) =>
      api(`/api/tasks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ done }),
      }),
    onSuccess: refresh,
  });

  // Outstanding first: the point of a follow-up list is what has not happened.
  const ordered = [...tasks].sort((a, b) => Number(a.done) - Number(b.done));

  return (
    <Card>
      <p className="mb-2 font-medium">Follow-ups</p>

      <div className="flex gap-2">
        <input
          value={title}
          placeholder="Call back about the quote"
          onChange={(e) => setTitle(e.target.value)}
          className="min-w-0 flex-1 rounded border px-2 py-1 text-sm"
          style={{
            background: "var(--surface-raised)",
            borderColor: "var(--border)",
            color: "var(--text)",
          }}
        />
        <input
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          className="rounded border px-2 py-1 text-sm"
          style={{
            background: "var(--surface-raised)",
            borderColor: "var(--border)",
            color: "var(--text)",
          }}
        />
      </div>
      <div className="mt-2">
        <Button
          onClick={() => add.mutate()}
          disabled={!title.trim() || add.isPending}
        >
          {add.isPending ? "Adding…" : "Add"}
        </Button>
      </div>
      {add.error ? <ErrorNote error={add.error} /> : null}

      {ordered.length === 0 ? (
        <p className="mt-3 text-sm" style={muted}>
          Nothing outstanding.
        </p>
      ) : (
        <ul className="mt-3 space-y-1 text-sm">
          {ordered.map((t) => (
            <li key={t.id} className="flex items-baseline gap-2">
              <input
                type="checkbox"
                checked={t.done}
                aria-label={`Done: ${t.title}`}
                onChange={(e) =>
                  toggle.mutate({ id: t.id, done: e.target.checked })
                }
              />
              <span className={t.done ? "line-through" : undefined}>
                {t.title}
                {t.dueAt ? (
                  <span className="ml-1 text-xs" style={muted}>
                    {formatDate(t.dueAt)}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Attaching a file to a note that already exists. */
function Attach({ noteId, onDone }: { noteId: string; onDone: () => void }) {
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      // No content-type header: FormData sets its own with the boundary, and
      // overriding it makes the body unparseable at the other end.
      const res = await fetch(`/api/notes/${noteId}/attachments`, {
        method: "POST",
        body: form,
        credentials: "same-origin",
      });
      if (!res.ok) {
        throw new Error(
          ((await res.json().catch(() => ({}))) as { error?: string }).error ??
            "That file could not be attached.",
        );
      }
    },
    onSuccess: onDone,
  });

  return (
    <>
      <label className="cursor-pointer text-xs underline" style={muted}>
        {upload.isPending ? "Attaching…" : "Attach a file"}
        <input
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate(file);
          }}
        />
      </label>
      {upload.error ? <ErrorNote error={upload.error} /> : null}
    </>
  );
}

function Notes({
  contactId,
  notes,
}: { contactId: string; notes: Related["notes"] }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");

  const add = useMutation({
    mutationFn: () =>
      api("/api/notes", {
        method: "POST",
        body: JSON.stringify({
          entityType: "contact",
          entityId: contactId,
          text,
        }),
      }),
    onSuccess: () => {
      setText("");
      qc.invalidateQueries({ queryKey: ["contact-related", contactId] });
    },
  });

  return (
    <Card>
      <p className="mb-2 font-medium">Notes</p>
      <textarea
        rows={2}
        value={text}
        placeholder="What was said?"
        onChange={(e) => setText(e.target.value)}
        className="w-full rounded border px-2 py-1.5 text-sm"
        style={{
          background: "var(--surface-raised)",
          borderColor: "var(--border)",
          color: "var(--text)",
        }}
      />
      <div className="mt-2">
        <Button
          onClick={() => add.mutate()}
          disabled={!text.trim() || add.isPending}
        >
          {add.isPending ? "Saving…" : "Add note"}
        </Button>
      </div>
      {add.error ? <ErrorNote error={add.error} /> : null}

      <div className="mt-3 space-y-2">
        {notes.length === 0 ? (
          <p className="text-sm" style={muted}>
            Nothing written down yet.
          </p>
        ) : (
          notes.map((n) => (
            <div
              key={n.id}
              className="border-t pt-2 text-sm"
              style={{ borderColor: "var(--border)" }}
            >
              <p className="whitespace-pre-wrap">{n.text}</p>

              {n.attachments?.length ? (
                <ul className="mt-1 space-y-0.5">
                  {n.attachments.map((a, i) => (
                    <li key={a.path} className="text-xs">
                      <a
                        href={`/api/notes/${n.id}/attachments/${i}`}
                        className="underline"
                      >
                        {a.name}
                      </a>
                      <span className="ml-1" style={muted}>
                        {Math.max(1, Math.round(a.size / 1024))} KB
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}

              <p
                className="mt-0.5 flex items-center gap-2 text-xs"
                style={muted}
              >
                {formatDate(n.createdAt)}
                <Attach
                  noteId={n.id}
                  onDone={() =>
                    qc.invalidateQueries({
                      queryKey: ["contact-related", contactId],
                    })
                  }
                />
              </p>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

export function ContactDetail() {
  const { current } = useNavigation();
  const id = current.recordId;
  const [editing, setEditing] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["contact-related", id],
    queryFn: () => api<Related>(`/api/contacts/${id}/related`),
    enabled: Boolean(id),
  });

  if (!id) return <Empty title="No contact selected" />;
  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const { contact, company, deals, notes, tasks, tags } = data;
  const emails = ways(contact.email, contact.emails);
  const phones = ways(contact.phone, contact.phones);
  const open = deals.filter((d) => d.stage !== "won" && d.stage !== "lost");

  if (editing) {
    return <EditContact contact={contact} onDone={() => setEditing(false)} />;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-4">
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <p className="text-lg font-semibold">{contact.name}</p>
              <p className="text-sm" style={muted}>
                {[contact.title, company?.name].filter(Boolean).join(" at ") ||
                  "No job title"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Tags contactId={contact.id} attached={tags} />
              <button
                type="button"
                className="text-sm underline"
                style={muted}
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
            </div>
          </div>

          {/* The company is a record, not a label — following it is the point. */}
          {company ? (
            <p className="mt-3 text-sm">
              <span style={muted}>Company: </span>
              <RelatedLink
                to={{
                  moduleId: "companies",
                  recordId: company.id,
                  title: company.name,
                }}
              >
                {company.name}
              </RelatedLink>
            </p>
          ) : null}

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs" style={muted}>
                Email
              </p>
              {emails.length ? (
                emails.map((e) => (
                  <p key={e.value} className="text-sm">
                    <a href={`mailto:${e.value}`} className="underline">
                      {e.value}
                    </a>
                    <span className="ml-1 text-xs" style={muted}>
                      {e.label}
                    </span>
                  </p>
                ))
              ) : (
                <p className="text-sm" style={muted}>
                  None
                </p>
              )}
            </div>
            <div>
              <p className="text-xs" style={muted}>
                Phone
              </p>
              {phones.length ? (
                phones.map((p) => (
                  <p key={p.value} className="text-sm">
                    <a href={`tel:${p.value}`} className="underline">
                      {p.value}
                    </a>
                    <span className="ml-1 text-xs" style={muted}>
                      {p.label}
                    </span>
                  </p>
                ))
              ) : (
                <p className="text-sm" style={muted}>
                  None
                </p>
              )}
            </div>
          </div>
        </Card>

        <Notes contactId={contact.id} notes={notes} />
      </div>

      <div className="space-y-4">
        <Card>
          <p className="mb-2 font-medium">
            Deals{" "}
            <span className="text-sm font-normal" style={muted}>
              ({open.length} open)
            </span>
          </p>
          {deals.length === 0 ? (
            <p className="text-sm" style={muted}>
              Not on any deals.
            </p>
          ) : (
            <div className="space-y-2">
              {deals.map((d) => (
                <div key={d.id} className="text-sm">
                  <RelatedLink
                    to={{ moduleId: "deals", recordId: d.id, title: d.name }}
                  >
                    {d.name}
                  </RelatedLink>
                  <div className="text-xs" style={muted}>
                    {d.stage} · {formatMoney(d.amountCents)}
                    {d.expectedCloseOn
                      ? ` · closes ${formatDate(d.expectedCloseOn)}`
                      : ""}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <FollowUps contactId={contact.id} tasks={tasks} />
      </div>
    </div>
  );
}
