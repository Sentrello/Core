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
  Select,
  formatDate,
  formatMoney,
  muted,
} from "../lib/ui";

/**
 * One deal: what it is worth, who is on it, and what was said.
 *
 * The board links here. Without this screen every card was a dead end — the
 * same failure a contact's company link had before companies got one.
 */

const STAGES = [
  { id: "opportunity", label: "Opportunity" },
  { id: "proposal", label: "Proposal" },
  { id: "negotiation", label: "Negotiation" },
  { id: "won", label: "Won" },
  { id: "lost", label: "Lost" },
];

interface Related {
  deal: {
    id: string;
    name: string;
    stage: string;
    amountCents: number;
    category: string | null;
    description: string | null;
    expectedCloseOn: string | null;
    archivedAt: string | null;
  };
  company: { id: string; name: string } | null;
  contacts: { id: string; name: string; title: string | null }[];
  notes: { id: string; text: string; createdAt: string }[];
}

export function DealDetail() {
  const { current } = useNavigation();
  const qc = useQueryClient();
  const id = current.recordId;
  const [text, setText] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["deal-related", id],
    queryFn: () => api<Related>(`/api/deals/${id}/related`),
    enabled: Boolean(id),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["deal-related", id] });
    // The board reads the same rows, so a stage changed here has to be stale
    // there too — otherwise going back shows the card where it used to be.
    qc.invalidateQueries({ queryKey: ["deals"] });
  };

  const move = useMutation({
    mutationFn: (stage: string) =>
      api(`/api/deals/${id}/move`, {
        method: "PATCH",
        body: JSON.stringify({ stage }),
      }),
    onSuccess: refresh,
  });

  const addNote = useMutation({
    mutationFn: () =>
      api("/api/notes", {
        method: "POST",
        body: JSON.stringify({ entityType: "deal", entityId: id, text }),
      }),
    onSuccess: () => {
      setText("");
      refresh();
    },
  });

  if (!id) return <Empty title="No deal selected" />;
  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const { deal, company, contacts, notes } = data;
  const closed = deal.stage === "won" || deal.stage === "lost";

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-4">
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <p className="text-lg font-semibold">{deal.name}</p>
              <p className="text-sm" style={muted}>
                {[
                  deal.category,
                  deal.expectedCloseOn
                    ? `closes ${formatDate(deal.expectedCloseOn)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "No category or close date"}
              </p>
            </div>
            <p className="money text-lg font-semibold">
              {formatMoney(deal.amountCents)}
            </p>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <span className="text-sm" style={muted}>
              Stage
            </span>
            <Select
              value={deal.stage}
              aria-label="Stage"
              onChange={(e) => move.mutate(e.target.value)}
            >
              {STAGES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
            {closed ? (
              <span className="text-xs" style={muted}>
                Closed deals stay on the board as history.
              </span>
            ) : null}
          </div>
          {move.error ? <ErrorNote error={move.error} /> : null}

          {deal.description ? (
            <p className="mt-3 whitespace-pre-wrap text-sm">
              {deal.description}
            </p>
          ) : null}
        </Card>

        <Card>
          <p className="mb-2 font-medium">Notes</p>
          <textarea
            rows={2}
            value={text}
            placeholder="What happened on this deal?"
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
              onClick={() => addNote.mutate()}
              disabled={!text.trim() || addNote.isPending}
            >
              {addNote.isPending ? "Saving…" : "Add note"}
            </Button>
          </div>
          {addNote.error ? <ErrorNote error={addNote.error} /> : null}

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
      </div>

      <div className="space-y-4">
        <Card>
          <p className="mb-2 font-medium">Who is involved</p>
          {company ? (
            <p className="mb-2 text-sm">
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

          {contacts.length === 0 ? (
            <p className="text-sm" style={muted}>
              Nobody attached to this deal.
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {contacts.map((p) => (
                <li key={p.id}>
                  <RelatedLink
                    to={{ moduleId: "crm", recordId: p.id, title: p.name }}
                  >
                    {p.name}
                  </RelatedLink>
                  {p.title ? (
                    <span className="ml-1 text-xs" style={muted}>
                      {p.title}
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
