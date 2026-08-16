import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { RelatedLink, useNavigation } from "../lib/navigation";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Loading,
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
  notes: { id: string; text: string; createdAt: string }[];
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
              <p className="mt-0.5 text-xs" style={muted}>
                {formatDate(n.createdAt)}
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
            {tags.length ? (
              <div className="flex flex-wrap gap-1">
                {tags.map((t) => (
                  <span
                    key={t.id}
                    className="rounded-full px-2 py-0.5 text-xs"
                    style={{ background: t.color, color: "#111" }}
                  >
                    {t.name}
                  </span>
                ))}
              </div>
            ) : null}
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

        <Card>
          <p className="mb-2 font-medium">Follow-ups</p>
          {tasks.length === 0 ? (
            <p className="text-sm" style={muted}>
              Nothing outstanding.
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {tasks.map((t) => (
                <li key={t.id} className={t.done ? "line-through" : undefined}>
                  {t.title}
                  {t.dueAt ? (
                    <span className="ml-1 text-xs" style={muted}>
                      {formatDate(t.dueAt)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
