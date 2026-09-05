import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Account, type Meta, type ProfitAndLoss, api } from "../lib/api";
import { toCents } from "../lib/money";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  Row,
  Select,
  Table,
  formatDate,
  formatMoney,
  muted,
} from "../lib/ui";
import {
  Banking,
  Bills,
  Budgets,
  Receipt,
  TaxAndCurrency,
} from "./accounting-pro";

/**
 * The Pro half, re-exported.
 *
 * Each of these is a page the sidebar names now rather than a tab this file
 * switched between, and the application maps nav ids to screens in one place.
 * Re-exporting keeps that one import rather than two.
 */
export { Banking, Bills, Budgets, TaxAndCurrency };

/**
 * The books.
 *
 * Four screens, in the order somebody actually uses them: what the business
 * earned and spent, the money going in and out, the accounts it lands in, and
 * the journal underneath when a figure has to be explained.
 */

type Transaction = {
  id: string;
  kind: "income" | "expense";
  accountId: string | null;
  paidThroughAccountId: string | null;
  amountCents: number;
  occurredAt: string;
  description: string | null;
  reference: string | null;
  method: string | null;
  receiptFileKey: string | null;
  reversedAt: string | null;
};

type AccountTotal = {
  accountId: string;
  code: string;
  name: string;
  balanceCents: number;
};

type Statement = ProfitAndLoss & {
  income: AccountTotal[];
  expenses: AccountTotal[];
};

type BalanceSheet = {
  asOf: string;
  assets: AccountTotal[];
  liabilities: AccountTotal[];
  equity: AccountTotal[];
  assetsCents: number;
  liabilitiesCents: number;
  equityCents: number;
  earningsCents: number;
  balanced: boolean;
};

function startOfYear(): string {
  return `${new Date().getFullYear()}-01-01`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Profit and loss and balance sheet, read straight from the ledger.
 *
 * Nothing is recomputed here: the journal is the source of truth, so an invoice
 * paid and an expense recorded show up in the same numbers an accountant would
 * arrive at from the entries.
 */
export function Summary() {
  const [from, setFrom] = useState(startOfYear());
  const [to, setTo] = useState(today());

  const pnl = useQuery({
    queryKey: ["profit-and-loss", from, to],
    queryFn: () =>
      api<Statement>(`/api/reports/profit-and-loss?from=${from}&to=${to}`),
  });
  const sheet = useQuery({
    queryKey: ["balance-sheet", to],
    queryFn: () => api<BalanceSheet>(`/api/reports/balance-sheet?asOf=${to}`),
  });

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-3 sm:grid-cols-[10rem_10rem]">
          <Field label="From">
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label="To">
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
        </div>
      </Card>

      {pnl.isLoading ? <Loading /> : null}
      {pnl.error ? <ErrorNote error={pnl.error} /> : null}
      {pnl.data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Figure label="Income" cents={pnl.data.incomeCents} />
            <Figure label="Expenses" cents={pnl.data.expenseCents} />
            <Figure label="Net" cents={pnl.data.netCents} emphasise />
          </div>

          <Card>
            <h2 className="mb-2 text-sm font-semibold">Profit and loss</h2>
            <Breakdown title="Income" rows={pnl.data.income} />
            <Breakdown title="Expenses" rows={pnl.data.expenses} />
          </Card>
        </>
      ) : null}

      {sheet.data ? (
        <Card>
          <h2 className="mb-2 text-sm font-semibold">
            Balance sheet as at {formatDate(sheet.data.asOf)}
          </h2>
          <Breakdown title="Assets" rows={sheet.data.assets} />
          <Breakdown title="Liabilities" rows={sheet.data.liabilities} />
          <Breakdown title="Equity" rows={sheet.data.equity} />
          <div className="mt-3 flex justify-between border-t pt-2 text-sm">
            <span>Earnings not drawn out</span>
            <span className="money">
              {formatMoney(sheet.data.earningsCents)}
            </span>
          </div>
          {!sheet.data.balanced ? (
            <p
              className="mt-2 text-xs"
              style={{ color: "var(--color-danger)" }}
            >
              This balance sheet does not balance. Something has reached the
              ledger that should not have — the journal will show what.
            </p>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: AccountTotal[] }) {
  /**
   * An account at zero is not a line on a statement.
   *
   * A settled payable reading "$0.00" is noise on the one screen where every
   * line should mean something — and after a few months of trading most of the
   * chart sits at zero.
   */
  const worth = rows.filter((row) => row.balanceCents !== 0);
  if (worth.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="text-xs font-medium" style={muted}>
        {title}
      </p>
      {worth.map((row) => (
        <div key={row.accountId} className="flex justify-between py-1 text-sm">
          <span>
            <span style={muted}>{row.code}</span> {row.name}
          </span>
          <span className="money">{formatMoney(row.balanceCents)}</span>
        </div>
      ))}
    </div>
  );
}

function Figure({
  label,
  cents,
  emphasise,
}: {
  label: string;
  cents: number;
  emphasise?: boolean;
}) {
  return (
    <Card>
      <p className="text-xs" style={muted}>
        {label}
      </p>
      <p
        className="money mt-1 text-xl font-semibold"
        style={
          emphasise && cents < 0 ? { color: "var(--color-danger)" } : undefined
        }
      >
        {formatMoney(cents)}
      </p>
    </Card>
  );
}

/** Money in and money out, where no invoice was involved. */
/** The tabs the reference puts across its transaction list. */
const MONEY_TABS: { id: string; label: string }[] = [
  { id: "", label: "Everything" },
  { id: "income", label: "Money in" },
  { id: "expense", label: "Money out" },
  { id: "transfer", label: "Transfers" },
];

export function Money() {
  const qc = useQueryClient();
  const [kind, setKind] = useState<"expense" | "income">("expense");
  /**
   * What the list is showing, as against what is being added.
   *
   * The server has taken `kind`, `from` and `to` since it was written and the
   * screen never sent any of them, so the only view of the books was
   * everything, newest first. "Fuel, this quarter" is the question a business
   * actually asks its bookkeeping.
   */
  const [tab, setTab] = useState("");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [paidThroughAccountId, setPaidThrough] = useState("");
  const [occurredAt, setOccurredAt] = useState("");

  const filter = [
    tab ? `kind=${tab}` : "",
    q.trim() ? `q=${encodeURIComponent(q.trim())}` : "",
    from ? `from=${from}` : "",
    to ? `to=${to}` : "",
  ]
    .filter(Boolean)
    .join("&");

  const transactions = useQuery({
    queryKey: ["transactions", filter],
    queryFn: () =>
      api<{
        transactions: Transaction[];
        totals: { inCents: number; outCents: number; netCents: number };
      }>(`/api/transactions${filter ? `?${filter}` : ""}`),
    placeholderData: (previous) => previous,
  });
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<{ accounts: Account[] }>("/api/accounts"),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["transactions"] });
    qc.invalidateQueries({ queryKey: ["profit-and-loss"] });
    qc.invalidateQueries({ queryKey: ["balance-sheet"] });
    qc.invalidateQueries({ queryKey: ["journal"] });
  };

  const add = useMutation({
    mutationFn: () =>
      api("/api/transactions", {
        method: "POST",
        body: JSON.stringify({
          kind,
          description: description || null,
          amountCents: toCents(amount),
          accountId: accountId || null,
          paidThroughAccountId: paidThroughAccountId || null,
          occurredAt: occurredAt || null,
        }),
      }),
    onSuccess: () => {
      setDescription("");
      setAmount("");
      setOccurredAt("");
      refresh();
    },
  });

  const undo = useMutation({
    mutationFn: (id: string) =>
      api(`/api/transactions/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  const accountName = (id: string | null) =>
    accounts.data?.accounts.find((a) => a.id === id)?.name ?? "—";

  const categoryAccounts = (accounts.data?.accounts ?? []).filter((a) =>
    kind === "expense" ? a.type === "expense" : a.type === "income",
  );
  const cashAccounts = (accounts.data?.accounts ?? []).filter(
    (a) => a.type === "asset",
  );

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-3 sm:grid-cols-[8rem_1fr_8rem_1fr_1fr_9rem_auto]">
          <Field label="Kind">
            <Select
              value={kind}
              onChange={(e) => setKind(e.target.value as "expense" | "income")}
            >
              <option value="expense">Money out</option>
              <option value="income">Money in</option>
            </Select>
          </Field>
          <Field label={kind === "expense" ? "Paid to" : "Received from"}>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field label="Amount">
            <Input
              type="number"
              step="0.01"
              min="0"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label="Category">
            <Select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">Unassigned</option>
              {categoryAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={kind === "expense" ? "Paid from" : "Paid into"}>
            <Select
              value={paidThroughAccountId}
              onChange={(e) => setPaidThrough(e.target.value)}
            >
              <option value="">Cash</option>
              {cashAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Date">
            <Input
              type="date"
              value={occurredAt}
              onChange={(e) => setOccurredAt(e.target.value)}
            />
          </Field>
          <div className="flex items-end">
            <Button
              onClick={() => add.mutate()}
              disabled={add.isPending || !amount}
            >
              Record
            </Button>
          </div>
        </div>
        {add.error ? <ErrorNote error={add.error} /> : null}
      </Card>

      <div
        className="flex flex-wrap items-center gap-1 border-b pb-2"
        style={{ borderColor: "var(--border)" }}
      >
        {MONEY_TABS.map((t) => (
          <button
            key={t.id || "all"}
            type="button"
            className="rounded-md px-3 py-1.5 text-sm"
            style={
              tab === t.id
                ? {
                    background: "var(--color-brand-500)",
                    color: "var(--color-neutral-50)",
                  }
                : undefined
            }
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Input
          value={q}
          className="w-56"
          placeholder="Search what it says"
          aria-label="Search transactions"
          onChange={(e) => setQ(e.target.value)}
        />
        <Field label="From">
          <Input
            type="date"
            value={from}
            className="w-40"
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label="To">
          <Input
            type="date"
            value={to}
            className="w-40"
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
        {/* What the rows on screen come to. Adding them up by hand off the
            screen is how a business gets a different answer every time. */}
        {transactions.data ? (
          <span className="ml-auto text-sm" style={muted}>
            in {formatMoney(transactions.data.totals.inCents)} · out{" "}
            {formatMoney(transactions.data.totals.outCents)} ·{" "}
            <strong
              style={{
                color:
                  transactions.data.totals.netCents < 0
                    ? "var(--color-danger)"
                    : "var(--color-success)",
              }}
            >
              {formatMoney(transactions.data.totals.netCents)}
            </strong>
          </span>
        ) : null}
      </div>

      {transactions.isLoading ? <Loading /> : null}
      {transactions.error ? <ErrorNote error={transactions.error} /> : null}
      {transactions.data && transactions.data.transactions.length === 0 ? (
        <Empty title={filter ? "Nothing matches" : "Nothing recorded yet"}>
          {filter
            ? "Try a wider date range, another tab, or part of what the line says."
            : "What you spend and take in goes here, and straight into the profit and loss."}
        </Empty>
      ) : null}
      {transactions.data && transactions.data.transactions.length > 0 ? (
        <Table
          headers={[
            "Date",
            "Detail",
            "Category",
            { label: "Amount", money: true },
            "Receipt",
            "",
          ]}
        >
          {transactions.data.transactions.map((t) => (
            <Row key={t.id}>
              <td className="py-2">{formatDate(t.occurredAt)}</td>
              <td style={t.reversedAt ? muted : undefined}>
                {t.description ?? "—"}
                {t.reversedAt ? " (undone)" : ""}
              </td>
              <td>{accountName(t.accountId)}</td>
              <td className="money">
                {t.kind === "expense" ? "−" : ""}
                {formatMoney(t.amountCents)}
              </td>
              <td>
                <Receipt
                  holder="transactions"
                  id={t.id}
                  has={Boolean(t.receiptFileKey)}
                  onDone={refresh}
                />
              </td>
              <td>
                {t.reversedAt ? null : (
                  <button
                    type="button"
                    className="text-xs underline"
                    style={muted}
                    onClick={() => undo.mutate(t.id)}
                  >
                    Undo
                  </button>
                )}
              </td>
            </Row>
          ))}
        </Table>
      ) : null}
      {undo.error ? <ErrorNote error={undo.error} /> : null}
    </div>
  );
}

type ChartAccount = Account & { archivedAt: string | null };

/**
 * The chart in the order an accountant reads it: parents by code, children
 * under their parent.
 *
 * An account whose parent is missing from the list — archived, while the
 * child is not — is shown at the top rather than dropped. A chart that
 * silently loses a row is worse than one that is slightly untidy.
 */
export function inTreeOrder(
  accounts: ChartAccount[],
): { account: ChartAccount; depth: number }[] {
  const byParent = new Map<string, ChartAccount[]>();
  const present = new Set(accounts.map((account) => account.id));
  for (const account of accounts) {
    const key =
      account.parentId && present.has(account.parentId) ? account.parentId : "";
    byParent.set(key, [...(byParent.get(key) ?? []), account]);
  }

  const out: { account: ChartAccount; depth: number }[] = [];
  const walk = (key: string, depth: number) => {
    // Bounded because data can be edited outside the screen, and a chart that
    // never finishes rendering is a page nobody can close.
    if (depth > 12) return;
    for (const account of (byParent.get(key) ?? []).sort((a, b) =>
      a.code.localeCompare(b.code),
    )) {
      out.push({ account, depth });
      walk(account.id, depth + 1);
    }
  };
  walk("", 0);
  return out;
}

export function Accounts() {
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState("expense");
  const [showArchived, setShowArchived] = useState(false);

  const accounts = useQuery({
    queryKey: ["accounts", showArchived],
    queryFn: () =>
      api<{ accounts: (Account & { archivedAt: string | null })[] }>(
        `/api/accounts${showArchived ? "?archived=1" : ""}`,
      ),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["accounts"] });

  const add = useMutation({
    mutationFn: () =>
      api("/api/accounts", {
        method: "POST",
        body: JSON.stringify({ code, name, type }),
      }),
    onSuccess: () => {
      setCode("");
      setName("");
      refresh();
    },
  });

  const standard = useMutation({
    mutationFn: () => api("/api/accounts/standard", { method: "POST" }),
    onSuccess: refresh,
  });

  const archive = useMutation({
    mutationFn: (input: { id: string; archived: boolean }) =>
      api(`/api/accounts/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: input.archived }),
      }),
    onSuccess: refresh,
  });

  /**
   * Filing an account under another.
   *
   * A chart of accounts is a tree in every accountant's head — Utilities under
   * Premises — even where the numbering already implies it. The server refuses
   * a loop however far round it goes, so this can offer every other account of
   * the same type and let it say no.
   */
  const reparent = useMutation({
    mutationFn: (input: { id: string; parentId: string }) =>
      api(`/api/accounts/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify({ parentId: input.parentId || null }),
      }),
    onSuccess: refresh,
  });

  if (accounts.isLoading) return <Loading />;
  if (accounts.error) return <ErrorNote error={accounts.error} />;
  const rows = accounts.data?.accounts ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-3 sm:grid-cols-[7rem_1fr_9rem_auto]">
          <Field label="Code">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="6100"
            />
          </Field>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {["asset", "liability", "equity", "income", "expense"].map(
                (t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ),
              )}
            </Select>
          </Field>
          <div className="flex items-end">
            <Button
              onClick={() => add.mutate()}
              disabled={add.isPending || !code || !name}
            >
              Add
            </Button>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button
            onClick={() => standard.mutate()}
            disabled={standard.isPending}
          >
            Fill in the standard chart
          </Button>
          <label className="flex items-center gap-1 text-xs" style={muted}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
        </div>
        <p className="mt-2 text-xs" style={muted}>
          The accounts Sentrello needs are created for you the first time they
          are used. The standard chart adds the ones a small business usually
          wants, and never adds one twice.
        </p>
        {add.error ? <ErrorNote error={add.error} /> : null}
      </Card>

      {rows.length === 0 ? (
        <Empty title="No accounts yet" />
      ) : (
        <Table headers={["Code", "Name", "Type", "Under", ""]}>
          {inTreeOrder(rows).map(({ account: a, depth }) => (
            <Row key={a.id}>
              <td className="py-2 font-medium">{a.code}</td>
              <td style={a.archivedAt ? muted : undefined}>
                <span style={{ paddingLeft: `${depth * 1.25}rem` }}>
                  {depth > 0 ? "↳ " : ""}
                  {a.name}
                </span>
              </td>
              <td style={muted}>{a.type}</td>
              <td>
                <Select
                  value={a.parentId ?? ""}
                  onChange={(e) =>
                    reparent.mutate({ id: a.id, parentId: e.target.value })
                  }
                >
                  <option value="">On its own</option>
                  {rows
                    .filter(
                      (other) => other.id !== a.id && other.type === a.type,
                    )
                    .map((other) => (
                      <option key={other.id} value={other.id}>
                        {other.code} {other.name}
                      </option>
                    ))}
                </Select>
              </td>
              <td>
                <button
                  type="button"
                  className="text-xs underline"
                  style={muted}
                  onClick={() =>
                    archive.mutate({ id: a.id, archived: !a.archivedAt })
                  }
                >
                  {a.archivedAt ? "Restore" : "Archive"}
                </button>
              </td>
            </Row>
          ))}
        </Table>
      )}
      {reparent.error ? <ErrorNote error={reparent.error} /> : null}
      {archive.error ? <ErrorNote error={archive.error} /> : null}
    </div>
  );
}

type JournalLine = {
  id: string;
  memo: string | null;
  source: string | null;
  postedAt: string;
  debitCents: number;
  creditCents: number;
  accountCode: string | null;
  accountName: string | null;
};

/**
 * The journal, which is what every figure above is made of.
 *
 * Read-only on purpose: an entry arrives here because something was recorded,
 * never because somebody typed it in, so there is no line in the books that no
 * document explains.
 */
export function Journal() {
  const journal = useQuery({
    queryKey: ["journal"],
    queryFn: () => api<{ lines: JournalLine[] }>("/api/journal"),
  });

  if (journal.isLoading) return <Loading />;
  if (journal.error) return <ErrorNote error={journal.error} />;
  const lines = journal.data?.lines ?? [];
  if (lines.length === 0) return <Empty title="Nothing posted yet" />;

  return (
    <Table
      headers={[
        "Date",
        "Entry",
        "Account",
        { label: "Debit", money: true },
        { label: "Credit", money: true },
      ]}
    >
      {lines.map((line, i) => (
        <Row key={`${line.id}-${i}`}>
          <td className="py-2">{formatDate(line.postedAt)}</td>
          <td>{line.memo ?? line.source ?? "—"}</td>
          <td>
            {line.accountCode ? (
              <>
                <span style={muted}>{line.accountCode}</span> {line.accountName}
              </>
            ) : (
              "—"
            )}
          </td>
          <td className="money">
            {line.debitCents ? formatMoney(line.debitCents) : ""}
          </td>
          <td className="money">
            {line.creditCents ? formatMoney(line.creditCents) : ""}
          </td>
        </Row>
      ))}
    </Table>
  );
}
