import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { Bars, Line, type Point } from "../lib/charts";
import { useNavigation } from "../lib/navigation";
import {
  Button,
  Card,
  ErrorNote,
  Input,
  Loading,
  formatMoney,
  muted,
} from "../lib/ui";

/**
 * What needs doing, and what is going wrong.
 *
 * A report answers a question somebody already has. This answers the one they
 * have not asked — so it leads with money already earned and not received,
 * because that is the number that changes what somebody does with their
 * morning.
 *
 * One screen, two dashboards. Free shows what the Core modules know plus the
 * case for Pro; Pro drops the selling, adds twelve months of ledger, and lets
 * somebody arrange it into tabs. Two files would have meant two dashboards
 * drifting apart, and the half nobody was looking at would be the Free one —
 * the half every new instance opens first.
 */

interface Health {
  version: string;
  uptimeSeconds: number;
  database: { reachable: boolean; sizeBytes: number | null };
  disk: { freeBytes: number; totalBytes: number; usedPercent: number } | null;
  memory: { usedBytes: number; totalBytes: number } | null;
}

interface Dashboard {
  tier: "free" | "pro";
  promote: {
    url: string;
    headline: string;
    points: string[];
    sponsorSlot: boolean;
  } | null;
  health: Health;
  money: {
    owedCents: number;
    overdueCents: number;
    unpaidCount: number;
    overdueCount: number;
  };
  pipeline: { openCount: number; openCents: number; wonCount: number };
  book: { contacts: number };
  attention: {
    id: string;
    kind: "invoice" | "quote" | "task";
    summary: string;
    detail: string;
    amountCents?: number;
  }[];
}

interface Insights {
  months: {
    month: string;
    incomeCents: number;
    expenseCents: number;
    netCents: number;
  }[];
  dealsByStage: { stage: string; count: number; cents: number }[];
  topCustomers: { name: string; cents: number }[];
  aging: { bucket: string; cents: number; count: number }[];
}

interface Tab {
  name: string;
  widgets: string[];
}

/** Every panel, and what to call it when somebody is choosing between them. */
const WIDGET_LABELS: Record<string, string> = {
  money: "Money owed",
  attention: "Needs attention",
  pipeline: "Pipeline",
  health: "This server",
  "revenue-trend": "Income and expenses",
  "cash-position": "Profit trend",
  "deals-by-stage": "Deals by stage",
  "top-customers": "Top customers",
  "invoice-aging": "How late the money is",
};

function Figure({
  label,
  value,
  hint,
  alarming,
}: {
  label: string;
  value: string;
  hint?: string;
  alarming?: boolean;
}) {
  return (
    <Card>
      <p className="text-xs" style={muted}>
        {label}
      </p>
      <p
        className="money mt-1 text-2xl font-semibold"
        style={alarming ? { color: "var(--color-danger)" } : undefined}
      >
        {value}
      </p>
      {hint ? (
        <p className="mt-0.5 text-xs" style={muted}>
          {hint}
        </p>
      ) : null}
    </Card>
  );
}

const WHERE: Record<string, { moduleId: string; title: string }> = {
  invoice: { moduleId: "invoicing", title: "Invoices" },
  quote: { moduleId: "quotes", title: "Quotes" },
  task: { moduleId: "contacts", title: "Contacts" },
};

export function Dashboard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api<Dashboard>("/api/dashboard"),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  return data.tier === "pro" ? (
    <ProDashboard data={data} />
  ) : (
    <FreeDashboard data={data} />
  );
}

function FreeDashboard({ data }: { data: Dashboard }) {
  const { promote } = data;
  return (
    <div className="space-y-4">
      <MoneyPanel data={data} />

      {/* Free only. A business that has paid should not be advertised to on
          the first screen it opens each morning — not being sold to is part of
          what was bought. */}
      {promote ? (
        <div className="grid gap-3 lg:grid-cols-[2fr_1fr]">
          <Card>
            <p className="font-medium">{promote.headline}</p>
            <ul className="mt-2 space-y-1 text-sm" style={muted}>
              {promote.points.map((point) => (
                <li key={point}>· {point}</li>
              ))}
            </ul>
            <a
              href={promote.url}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-block rounded px-3 py-1.5 text-sm"
              style={{
                background: "var(--color-brand-500)",
                color: "var(--color-neutral-50)",
              }}
            >
              See what Pro adds
            </a>
          </Card>

          {promote.sponsorSlot ? (
            <Card>
              <p className="text-xs" style={muted}>
                Sponsored
              </p>
              <div
                className="mt-2 flex h-24 items-center justify-center rounded border border-dashed text-sm"
                style={{ borderColor: "var(--border)", ...muted }}
              >
                This space is available
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}

      <AttentionPanel data={data} />
      <HealthPanel health={data.health} />
    </div>
  );
}

/**
 * The Pro dashboard: the same figures, arranged by whoever is reading them.
 *
 * Tabs rather than one long scroll, because the person who wants the ledger
 * charts every Monday is not the person who wants the overdue list every
 * morning, and on most instances they are the same person on different days.
 */
function ProDashboard({ data }: { data: Dashboard }) {
  const [active, setActive] = useState(0);
  const [arranging, setArranging] = useState(false);

  const layout = useQuery({
    queryKey: ["dashboard", "layout"],
    queryFn: () =>
      api<{ tabs: Tab[]; widgets: string[] }>("/api/dashboard/layout"),
  });
  const insights = useQuery({
    queryKey: ["dashboard", "insights"],
    queryFn: () => api<Insights>("/api/dashboard/insights"),
  });

  if (layout.isLoading) return <Loading />;
  if (layout.error) return <ErrorNote error={layout.error} />;
  if (!layout.data) return null;

  const tabs = layout.data.tabs;
  const current = tabs[Math.min(active, tabs.length - 1)];

  return (
    <div className="space-y-4">
      <div
        className="flex flex-wrap items-center gap-1 border-b"
        style={{ borderColor: "var(--border)" }}
      >
        {tabs.map((tab, i) => (
          <button
            key={tab.name}
            type="button"
            className="-mb-px border-b-2 px-3 py-2 text-sm"
            style={
              i === active
                ? {
                    borderColor: "var(--color-brand-500)",
                    color: "var(--color-brand-500)",
                  }
                : { borderColor: "transparent", ...muted }
            }
            onClick={() => setActive(i)}
          >
            {tab.name}
          </button>
        ))}
        <button
          type="button"
          className="ml-auto text-sm underline"
          style={muted}
          onClick={() => setArranging((a) => !a)}
        >
          {arranging ? "Done arranging" : "Arrange"}
        </button>
      </div>

      {arranging ? (
        <Arrange
          tabs={tabs}
          widgets={layout.data.widgets}
          onSaved={() => {
            setArranging(false);
            setActive(0);
          }}
        />
      ) : null}

      <div className="space-y-4">
        {(current?.widgets ?? []).map((widget) => (
          <Widget
            key={widget}
            id={widget}
            data={data}
            insights={insights.data}
          />
        ))}
        {current && current.widgets.length === 0 ? (
          <Card>
            <p className="text-sm" style={muted}>
              This tab is empty. Use “Arrange” to put something on it.
            </p>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function Widget({
  id,
  data,
  insights,
}: {
  id: string;
  data: Dashboard;
  insights: Insights | undefined;
}) {
  switch (id) {
    case "money":
      return <MoneyPanel data={data} />;
    case "attention":
      return <AttentionPanel data={data} />;
    case "health":
      return <HealthPanel health={data.health} />;
    case "pipeline":
      return (
        <Card>
          <p className="mb-2 font-medium">Pipeline</p>
          <div className="grid gap-3 sm:grid-cols-3 text-sm">
            <Stat
              label="Open"
              value={formatMoney(data.pipeline.openCents)}
              hint={`${data.pipeline.openCount} deals`}
            />
            <Stat label="Won" value={String(data.pipeline.wonCount)} />
            <Stat
              label="People in the book"
              value={String(data.book.contacts)}
            />
          </div>
        </Card>
      );
    default:
      return <InsightWidget id={id} insights={insights} />;
  }
}

/** The panels that need the twelve-month query, which loads after the rest. */
function InsightWidget({
  id,
  insights,
}: {
  id: string;
  insights: Insights | undefined;
}) {
  if (!insights) {
    return (
      <Card>
        <p className="mb-2 font-medium">{WIDGET_LABELS[id] ?? id}</p>
        <Loading />
      </Card>
    );
  }

  const monthLabel = (month: string) => month.slice(2).replace("-", "/");

  if (id === "revenue-trend") {
    const points: Point[] = insights.months.map((m) => ({
      label: monthLabel(m.month),
      value: m.incomeCents,
      display: formatMoney(m.incomeCents),
    }));
    return (
      <Card>
        <p className="mb-2 font-medium">Income by month</p>
        <Bars points={points} />
      </Card>
    );
  }

  if (id === "cash-position") {
    const points: Point[] = insights.months.map((m) => ({
      label: monthLabel(m.month),
      value: m.netCents,
      display: formatMoney(m.netCents),
    }));
    return (
      <Card>
        <p className="mb-2 font-medium">Profit by month</p>
        <Line points={points} />
      </Card>
    );
  }

  if (id === "deals-by-stage") {
    return (
      <Card>
        <p className="mb-2 font-medium">Deals by stage</p>
        {insights.dealsByStage.length === 0 ? (
          <p className="text-sm" style={muted}>
            No open deals.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {insights.dealsByStage.map((s) => (
              <li key={s.stage} className="flex justify-between">
                <span className="capitalize">
                  {s.stage} · {s.count}
                </span>
                <span className="money">{formatMoney(s.cents)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    );
  }

  if (id === "top-customers") {
    return (
      <Card>
        <p className="mb-2 font-medium">Top customers</p>
        {insights.topCustomers.length === 0 ? (
          <p className="text-sm" style={muted}>
            No invoices sent yet.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {insights.topCustomers.map((c) => (
              <li key={c.name} className="flex justify-between">
                <span>{c.name}</span>
                <span className="money">{formatMoney(c.cents)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    );
  }

  if (id === "invoice-aging") {
    return (
      <Card>
        <p className="mb-2 font-medium">How late the money is</p>
        <div className="grid gap-3 sm:grid-cols-5 text-sm">
          {insights.aging.map((a) => (
            <Stat
              key={a.bucket}
              label={a.bucket}
              value={formatMoney(a.cents)}
              hint={`${a.count} invoice${a.count === 1 ? "" : "s"}`}
            />
          ))}
        </div>
      </Card>
    );
  }

  // A layout saved by a newer version can name a panel this build cannot draw.
  // Skipping it quietly is better than an error where a chart should be.
  return null;
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div>
      <p className="text-xs" style={muted}>
        {label}
      </p>
      <p className="money">{value}</p>
      {hint ? (
        <p className="text-xs" style={muted}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Arranging the tabs.
 *
 * Checkboxes and a text box, not a drag-and-drop canvas. What is being decided
 * is which of nine panels appear on which of up to six tabs — a list handles
 * that, and a canvas would be more to build, more to break, and no easier.
 */
function Arrange({
  tabs,
  widgets,
  onSaved,
}: {
  tabs: Tab[];
  widgets: string[];
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Tab[]>(tabs);

  const save = useMutation({
    mutationFn: () =>
      api<{ tabs: Tab[] }>("/api/dashboard/layout", {
        method: "PUT",
        body: JSON.stringify({ tabs: draft }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dashboard", "layout"] });
      onSaved();
    },
  });

  const toggle = (index: number, widget: string) =>
    setDraft((d) =>
      d.map((tab, i) =>
        i !== index
          ? tab
          : {
              ...tab,
              widgets: tab.widgets.includes(widget)
                ? tab.widgets.filter((w) => w !== widget)
                : [...tab.widgets, widget],
            },
      ),
    );

  return (
    <Card>
      <p className="mb-2 font-medium">Arrange your dashboard</p>
      <div className="space-y-4">
        {draft.map((tab, i) => (
          <div
            key={`tab-${i}-${tab.name}`}
            className="border-t pt-3"
            style={{ borderColor: "var(--border)" }}
          >
            <div className="flex items-center gap-2">
              <Input
                value={tab.name}
                onChange={(e) =>
                  setDraft((d) =>
                    d.map((t, j) =>
                      i === j ? { ...t, name: e.target.value } : t,
                    ),
                  )
                }
              />
              <button
                type="button"
                className="text-xs"
                style={{ color: "var(--color-danger)" }}
                onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
              >
                Remove tab
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-3 text-sm">
              {widgets.map((widget) => (
                <label key={widget} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={tab.widgets.includes(widget)}
                    onChange={() => toggle(i, widget)}
                  />
                  {WIDGET_LABELS[widget] ?? widget}
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {/* Six is the server's limit too. Stopping here as well means somebody
            is told why rather than losing the seventh tab on save. */}
        <Button
          variant="secondary"
          disabled={draft.length >= 6}
          onClick={() =>
            setDraft((d) => [
              ...d,
              { name: `Tab ${d.length + 1}`, widgets: [] },
            ])
          }
        >
          {draft.length >= 6 ? "Six tabs is the limit" : "Add a tab"}
        </Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save layout"}
        </Button>
      </div>
      {save.error ? <ErrorNote error={save.error} /> : null}
    </Card>
  );
}

function MoneyPanel({ data }: { data: Dashboard }) {
  const { money, pipeline, book } = data;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Figure
        label="Owed to you"
        value={formatMoney(money.owedCents)}
        hint={`${money.unpaidCount} unpaid invoice${money.unpaidCount === 1 ? "" : "s"}`}
      />
      <Figure
        label="Overdue"
        value={formatMoney(money.overdueCents)}
        hint={`${money.overdueCount} past its date`}
        // The only figure here worth colouring: it is money already earned
        // and not received, and it is the one somebody should act on today.
        alarming={money.overdueCents > 0}
      />
      <Figure
        label="In the pipeline"
        value={formatMoney(pipeline.openCents)}
        hint={`${pipeline.openCount} open deal${pipeline.openCount === 1 ? "" : "s"}`}
      />
      <Figure
        label="People in the book"
        value={String(book.contacts)}
        hint={`${pipeline.wonCount} deal${pipeline.wonCount === 1 ? "" : "s"} won`}
      />
    </div>
  );
}

function AttentionPanel({ data }: { data: Dashboard }) {
  const { go } = useNavigation();
  const { attention } = data;

  return (
    <Card>
      <p className="mb-2 font-medium">Needs attention</p>
      {attention.length === 0 ? (
        <p className="text-sm" style={muted}>
          Nothing overdue and no quotes waiting. Everything is where it should
          be.
        </p>
      ) : (
        <ul className="space-y-2">
          {attention.map((item) => {
            const to = WHERE[item.kind];
            return (
              <li
                key={`${item.kind}-${item.id}`}
                className="flex flex-wrap items-baseline justify-between gap-2 border-t pt-2 text-sm"
                style={{ borderColor: "var(--border)" }}
              >
                <div>
                  {/* Goes to the screen that can do something about it —
                      a list of problems with no way through to them is a
                      worse version of not showing them. */}
                  <button
                    type="button"
                    className="underline-offset-2 hover:underline"
                    onClick={() => to && go(to.moduleId, to.title)}
                  >
                    {item.summary}
                  </button>
                  {item.detail ? (
                    <div className="text-xs" style={muted}>
                      {item.detail}
                    </div>
                  ) : null}
                </div>
                {item.amountCents === undefined ? null : (
                  <span className="money">{formatMoney(item.amountCents)}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** Bytes, in a unit somebody can act on. */
function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

/** Uptime as a person would say it, not as seconds. */
function since(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86_400)} days`;
}

/**
 * How the server itself is doing.
 *
 * A self-hosted business owns the machine and nobody is watching it for them.
 * The first they usually hear of a full disk is a failed backup, so the number
 * that predicts it goes where they look every morning.
 */
function HealthPanel({ health }: { health: Health }) {
  const disk = health.disk;
  // Named rather than a bar: 91% reads as a number, "running out of space"
  // reads as something to do today.
  const tight = disk ? disk.usedPercent >= 85 : false;

  return (
    <Card>
      <p className="mb-2 font-medium">This server</p>
      <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="text-xs" style={muted}>
            Version
          </p>
          <p>{health.version}</p>
        </div>
        <div>
          <p className="text-xs" style={muted}>
            Running for
          </p>
          <p>{since(health.uptimeSeconds)}</p>
        </div>
        <div>
          <p className="text-xs" style={muted}>
            Database
          </p>
          <p
            style={
              health.database.reachable
                ? undefined
                : { color: "var(--color-danger)" }
            }
          >
            {health.database.reachable
              ? health.database.sizeBytes
                ? size(health.database.sizeBytes)
                : "reachable"
              : "not reachable"}
          </p>
        </div>
        <div>
          <p className="text-xs" style={muted}>
            Disk
          </p>
          {disk ? (
            <p style={tight ? { color: "var(--color-warning)" } : undefined}>
              {size(disk.freeBytes)} free
              {tight ? " — running low" : ""}
            </p>
          ) : (
            <p style={muted}>not measurable here</p>
          )}
        </div>
      </div>
    </Card>
  );
}
