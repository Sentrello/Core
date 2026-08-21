import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { RelatedLink, useNavigation } from "../lib/navigation";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Loading,
  formatMoney,
  muted,
} from "../lib/ui";

/**
 * The pipeline, as a board.
 *
 * Each column carries its total, because the question a business asks a
 * pipeline is "how much is in play", not "how many cards are there". A board
 * that only counts cards makes a £2,000 job look like a £20,000 one.
 */

interface Deal {
  id: string;
  name: string;
  stage: string;
  amountCents: number;
  category: string | null;
  expectedCloseOn: string | null;
  position: number;
  companyId: string | null;
  archivedAt: string | null;
}

/** Left to right, in the order a deal actually travels. */
/**
 * What the board draws before the server has answered.
 *
 * These used to *be* the pipeline, hard-coded here, which meant every business
 * ran the process a developer picked. They are now only the fallback: CRM
 * Settings owns the real list, and an instance that has never opened it gets
 * exactly these.
 */
const DEFAULT_STAGES = [
  { id: "opportunity", label: "Opportunity" },
  { id: "proposal", label: "Proposal" },
  { id: "negotiation", label: "Negotiation" },
  { id: "won", label: "Won" },
  { id: "lost", label: "Lost" },
];

interface Stage {
  id: string;
  label: string;
}

function Column({
  stages,
  stage,
  label,
  deals,
  onMove,
}: {
  /** Every stage, so a card can be moved to any of them without a mouse. */
  stages: Stage[];
  stage: string;
  label: string;
  deals: Deal[];
  onMove: (id: string, stage: string) => void;
}) {
  const { open } = useNavigation();
  const total = deals.reduce((sum, d) => sum + d.amountCents, 0);

  return (
    <div
      className="flex w-64 shrink-0 flex-col rounded-lg border p-2"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      // Dropping is how a card changes column. Keyboard users get the select
      // on each card instead, so the board is not mouse-only.
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData("text/plain");
        if (id) onMove(id, stage);
      }}
    >
      <div className="mb-2 flex items-baseline justify-between px-1">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs" style={muted}>
          {deals.length} · {formatMoney(total)}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {deals.map((d) => (
          <div
            key={d.id}
            draggable
            onDragStart={(e) => e.dataTransfer.setData("text/plain", d.id)}
            className="rounded border p-2"
            style={{
              borderColor: "var(--border)",
              background: "var(--surface-raised)",
            }}
          >
            <RelatedLink
              to={{ moduleId: "deals", recordId: d.id, title: d.name }}
            >
              {d.name}
            </RelatedLink>
            <div className="mt-0.5 text-xs" style={muted}>
              {formatMoney(d.amountCents)}
              {d.category ? ` · ${d.category}` : ""}
            </div>

            {/* The same move, reachable without a mouse. */}
            <select
              value={d.stage}
              onChange={(e) => onMove(d.id, e.target.value)}
              aria-label={`Stage for ${d.name}`}
              className="mt-1 w-full rounded border px-1 py-0.5 text-xs"
              style={{
                borderColor: "var(--border)",
                background: "var(--surface)",
                color: "var(--text)",
              }}
            >
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        ))}
        {deals.length === 0 ? (
          <p className="px-1 py-2 text-xs" style={muted}>
            Nothing here.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function Deals() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["deals"],
    queryFn: () => api<{ deals: Deal[] }>("/api/deals"),
  });

  /**
   * The pipeline this business actually runs, from CRM Settings.
   *
   * Falls back to the defaults rather than an empty board while it loads, and
   * on an instance that has never configured them.
   */
  const settings = useQuery({
    queryKey: ["crm-settings"],
    queryFn: () => api<{ dealStages: Stage[] }>("/api/crm/settings"),
  });
  const stages = settings.data?.dealStages ?? DEFAULT_STAGES;

  const move = useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: string }) =>
      api(`/api/deals/${id}/move`, {
        method: "PATCH",
        body: JSON.stringify({ stage }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["deals"] }),
  });

  const create = useMutation({
    mutationFn: () =>
      api("/api/deals", {
        method: "POST",
        body: JSON.stringify({
          name,
          // Typed in pounds or dollars; stored as integer cents, like all money
          // in this system.
          amountCents: Math.round(Number(amount || 0) * 100),
          stage: "opportunity",
        }),
      }),
    onSuccess: () => {
      setName("");
      setAmount("");
      setAdding(false);
      qc.invalidateQueries({ queryKey: ["deals"] });
    },
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;

  const deals = (data?.deals ?? []).filter((d) => !d.archivedAt);
  const byStage = (stage: string) =>
    deals
      .filter((d) => d.stage === stage)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

  const openTotal = deals
    .filter((d) => d.stage !== "won" && d.stage !== "lost")
    .reduce((sum, d) => sum + d.amountCents, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm" style={muted}>
          {formatMoney(openTotal)} in play across {deals.length} deals
        </p>
        <Button onClick={() => setAdding((v) => !v)}>
          {adding ? "Cancel" : "New deal"}
        </Button>
      </div>

      {adding ? (
        <Card>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Amount" hint="What the job is worth.">
              <Input
                value={amount}
                inputMode="decimal"
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
          </div>
          <div className="mt-3">
            <Button
              onClick={() => create.mutate()}
              disabled={!name.trim() || create.isPending}
            >
              {create.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
          {create.error ? <ErrorNote error={create.error} /> : null}
        </Card>
      ) : null}

      {move.error ? <ErrorNote error={move.error} /> : null}

      {/* Scrolls sideways rather than squeezing five columns onto a phone. */}
      <div className="flex gap-3 overflow-x-auto pb-2">
        {stages.map((s) => (
          <Column
            key={s.id}
            stages={stages}
            stage={s.id}
            label={s.label}
            deals={byStage(s.id)}
            onMove={(id, stage) => move.mutate({ id, stage })}
          />
        ))}
      </div>
    </div>
  );
}
