import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useNavigation } from "../lib/navigation";
import { Card, ErrorNote, Loading, formatMoney, muted } from "../lib/ui";

/**
 * What needs doing, and what is going wrong.
 *
 * A report answers a question somebody already has. This answers the one they
 * have not asked — so it leads with money already earned and not received,
 * because that is the number that changes what somebody does with their
 * morning.
 */

interface Dashboard {
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
  task: { moduleId: "crm", title: "Contacts" },
};

export function Dashboard() {
  const { go } = useNavigation();
  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api<Dashboard>("/api/dashboard"),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const { money, pipeline, book, attention } = data;

  return (
    <div className="space-y-4">
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
                    <span className="money">
                      {formatMoney(item.amountCents)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
