import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Avatar } from "../lib/avatar";
import { useNavigation } from "../lib/navigation";
import { Card, ErrorNote, Loading, formatMoney, muted } from "../lib/ui";

/**
 * The CRM's own front page.
 *
 * Four panels, in the order somebody needs them on a Tuesday morning: what is
 * due, what is about to land, who is live, what happened lately. Atomic CRM's
 * dashboard is the model — short, and every row a link to the record it is
 * about rather than a number to admire.
 *
 * Its "Welcome" stepper is deliberately not here. A panel explaining the
 * product to somebody who already bought it is a panel they scroll past
 * forever, and it takes the space the actual work should occupy.
 */

interface CrmDashboard {
  hotContacts: {
    id: string;
    name: string;
    email: string | null;
    companyId: string | null;
    lastActivityAt: string;
  }[];
  upcomingRevenue: {
    horizonDays: number;
    totalCents: number;
    deals: {
      id: string;
      name: string;
      amountCents: number;
      stage: string;
      expectedCloseOn: string | null;
    }[];
    overdue: { count: number; totalCents: number };
  };
  latestActivity: {
    id: string;
    type: string;
    body: string | null;
    occurredAt: string;
    contactId: string | null;
  }[];
  tasks: {
    id: string;
    title: string;
    type: string | null;
    dueAt: string;
    contactId: string | null;
    overdue: boolean;
  }[];
  goingCold: number;
}

/** "3 days ago", because an exact timestamp is not what anybody is asking. */
function ago(value: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  const days = Math.floor(seconds / 86_400);
  if (days >= 14) return `${Math.floor(days / 7)} weeks ago`;
  if (days >= 1) return days === 1 ? "yesterday" : `${days} days ago`;
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  return "just now";
}

/** "in 4 days", or how late it is, which is the part that matters. */
function until(value: string): string {
  const seconds = (new Date(value).getTime() - Date.now()) / 1000;
  const days = Math.round(Math.abs(seconds) / 86_400);
  if (seconds < 0) return days <= 1 ? "overdue" : `${days} days late`;
  if (days === 0) return "today";
  return days === 1 ? "tomorrow" : `in ${days} days`;
}

export function CrmDashboard() {
  const { open, go } = useNavigation();
  const { data, isLoading, error } = useQuery({
    queryKey: ["crm-dashboard"],
    queryFn: () => api<CrmDashboard>("/api/crm/dashboard"),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const { upcomingRevenue: revenue } = data;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/*
        Tasks first. Everything else on this screen is something to know;
        this is the only panel that is something to do.
      */}
      <Card>
        <p className="mb-3 font-medium">Your tasks</p>
        {data.tasks.length ? (
          <ul className="space-y-1">
            {data.tasks.map((task) => (
              <li
                key={task.id}
                className="flex items-baseline justify-between gap-3 border-t py-1.5 text-sm first:border-0"
                style={{ borderColor: "var(--border)" }}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left"
                  onClick={() =>
                    task.contactId &&
                    open({
                      moduleId: "contacts",
                      recordId: task.contactId,
                      title: task.title,
                    })
                  }
                >
                  {task.title}
                  {task.type ? (
                    <span className="ml-2 text-xs" style={muted}>
                      {task.type}
                    </span>
                  ) : null}
                </button>
                <span
                  className="shrink-0 text-xs"
                  style={
                    task.overdue ? { color: "var(--color-warning)" } : muted
                  }
                >
                  {until(task.dueAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm" style={muted}>
            Nothing due. Follow-ups you add to a contact or a deal appear here.
          </p>
        )}
      </Card>

      {/*
        What is about to land. Not weighted by stage: a probability-weighted
        forecast is a number nobody can check, and this one is four deals a
        person can go and chase this afternoon.
      */}
      <Card>
        <div className="mb-3 flex items-baseline justify-between">
          <p className="font-medium">Closing in {revenue.horizonDays} days</p>
          <p className="text-lg font-semibold tabular-nums">
            {formatMoney(revenue.totalCents)}
          </p>
        </div>

        {revenue.overdue.count > 0 ? (
          /*
            Kept out of the total and shown anyway. A deal past its close date
            is a conversation somebody is avoiding, and folding it into the
            forecast hides the one thing here worth acting on.
          */
          <button
            type="button"
            className="mb-3 w-full rounded border px-3 py-2 text-left text-sm"
            style={{
              borderColor: "var(--color-warning)",
              color: "var(--color-warning)",
            }}
            onClick={() => go("deals", "Deals")}
          >
            {revenue.overdue.count} deal
            {revenue.overdue.count === 1 ? "" : "s"} past the date they were
            meant to close — {formatMoney(revenue.overdue.totalCents)}
          </button>
        ) : null}

        {revenue.deals.length ? (
          <ul className="space-y-1">
            {revenue.deals.map((deal) => (
              <li
                key={deal.id}
                className="flex items-baseline justify-between gap-3 border-t py-1.5 text-sm first:border-0"
                style={{ borderColor: "var(--border)" }}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left"
                  onClick={() =>
                    open({
                      moduleId: "deals",
                      recordId: deal.id,
                      title: deal.name,
                    })
                  }
                >
                  {deal.name}
                  <span className="ml-2 text-xs" style={muted}>
                    {deal.stage}
                  </span>
                </button>
                <span className="shrink-0 tabular-nums">
                  {formatMoney(deal.amountCents)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm" style={muted}>
            No deals have a close date inside the next {revenue.horizonDays}{" "}
            days.
          </p>
        )}
      </Card>

      {/*
        Who is live. Ranked by what has actually happened rather than
        alphabetically — contacts nobody has ever spoken to are absent, because
        a list that opens with strangers is one people learn to ignore.
      */}
      <Card>
        <div className="mb-3 flex items-baseline justify-between">
          <p className="font-medium">Hot contacts</p>
          {data.goingCold > 0 ? (
            <button
              type="button"
              className="text-xs underline"
              style={muted}
              onClick={() => go("contacts", "Contacts")}
            >
              {data.goingCold} going quiet
            </button>
          ) : null}
        </div>

        {data.hotContacts.length ? (
          <ul className="space-y-1">
            {data.hotContacts.map((contact) => (
              <li key={contact.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 border-t py-2 text-left text-sm first:border-0"
                  style={{ borderColor: "var(--border)" }}
                  onClick={() =>
                    open({
                      moduleId: "contacts",
                      recordId: contact.id,
                      title: contact.name,
                    })
                  }
                >
                  <Avatar
                    src={`/api/crm/contacts/${contact.id}/image`}
                    name={contact.name}
                    size={32}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{contact.name}</span>
                    <span className="block truncate text-xs" style={muted}>
                      {contact.email ?? "no email"}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs" style={muted}>
                    {ago(contact.lastActivityAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm" style={muted}>
            Nothing logged yet. Calls, emails and notes on a contact show up
            here.
          </p>
        )}
      </Card>

      <Card>
        <p className="mb-3 font-medium">Latest activity</p>
        {data.latestActivity.length ? (
          <ul className="space-y-1">
            {data.latestActivity.map((activity) => (
              <li
                key={activity.id}
                className="border-t py-1.5 text-sm first:border-0"
                style={{ borderColor: "var(--border)" }}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span
                    className="text-xs uppercase tracking-wide"
                    style={muted}
                  >
                    {activity.type}
                  </span>
                  <span className="shrink-0 text-xs" style={muted}>
                    {ago(activity.occurredAt)}
                  </span>
                </div>
                {activity.body ? (
                  <p className="mt-0.5 line-clamp-2">{activity.body}</p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm" style={muted}>
            No calls, emails or notes recorded yet.
          </p>
        )}
      </Card>
    </div>
  );
}
