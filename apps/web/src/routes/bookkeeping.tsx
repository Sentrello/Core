import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  type Account,
  type Expense,
  type ProfitAndLoss,
  api,
} from "../lib/api";
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

export function Bookkeeping() {
  const [tab, setTab] = useState<"summary" | "expenses" | "accounts">(
    "summary",
  );

  return (
    <div className="space-y-4">
      <nav className="flex gap-1 text-sm">
        {(["summary", "expenses", "accounts"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className="rounded px-2 py-1 capitalize"
            style={
              tab === t
                ? {
                    background: "var(--color-brand-500)",
                    color: "var(--color-neutral-50)",
                  }
                : muted
            }
          >
            {t}
          </button>
        ))}
      </nav>

      {tab === "summary" ? <Summary /> : null}
      {tab === "expenses" ? <Expenses /> : null}
      {tab === "accounts" ? <Accounts /> : null}
    </div>
  );
}

/**
 * Profit and loss, read straight from the ledger.
 *
 * Nothing is recomputed here: the journal is the source of truth, so an invoice
 * paid and an expense recorded show up in the same numbers an accountant would
 * arrive at from the entries.
 */
function Summary() {
  const pnl = useQuery({
    queryKey: ["profit-and-loss"],
    queryFn: () => api<ProfitAndLoss>("/api/reports/profit-and-loss"),
  });

  if (pnl.isLoading) return <Loading />;
  if (pnl.error) return <ErrorNote error={pnl.error} />;
  const data = pnl.data;
  if (!data) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Figure label="Income" cents={data.incomeCents} />
      <Figure label="Expenses" cents={data.expenseCents} />
      <Figure label="Net" cents={data.netCents} emphasise />
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

function Expenses() {
  const qc = useQueryClient();
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [spentAt, setSpentAt] = useState("");

  const expenses = useQuery({
    queryKey: ["expenses"],
    queryFn: () => api<{ expenses: Expense[] }>("/api/expenses"),
  });
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<{ accounts: Account[] }>("/api/accounts"),
  });

  const add = useMutation({
    mutationFn: () =>
      api("/api/expenses", {
        method: "POST",
        body: JSON.stringify({
          vendor: vendor || null,
          amountCents: toCents(amount),
          accountId: accountId || null,
          spentAt: spentAt || null,
        }),
      }),
    onSuccess: () => {
      setVendor("");
      setAmount("");
      setSpentAt("");
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["profit-and-loss"] });
    },
  });

  const accountName = (id: string | null) =>
    accounts.data?.accounts.find((a) => a.id === id)?.name ?? "—";

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem_1fr_9rem_auto]">
          <Field label="Vendor">
            <Input value={vendor} onChange={(e) => setVendor(e.target.value)} />
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
          <Field label="Account">
            <Select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">Unassigned</option>
              {(accounts.data?.accounts ?? [])
                .filter((a) => a.type === "expense")
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Date">
            <Input
              type="date"
              value={spentAt}
              onChange={(e) => setSpentAt(e.target.value)}
            />
          </Field>
          <div className="flex items-end">
            <Button
              onClick={() => add.mutate()}
              disabled={add.isPending || !amount}
            >
              Add
            </Button>
          </div>
        </div>
        {add.error ? <ErrorNote error={add.error} /> : null}
      </Card>

      {expenses.isLoading ? <Loading /> : null}
      {expenses.error ? <ErrorNote error={expenses.error} /> : null}
      {expenses.data && expenses.data.expenses.length === 0 ? (
        <Empty title="No expenses recorded">
          What you spend goes here, and straight into the profit and loss.
        </Empty>
      ) : null}
      {expenses.data && expenses.data.expenses.length > 0 ? (
        <Table
          headers={[
            "Date",
            "Vendor",
            "Account",
            { label: "Amount", money: true },
          ]}
        >
          {expenses.data.expenses.map((e) => (
            <Row key={e.id}>
              <td className="py-2">{formatDate(e.spentAt)}</td>
              <td>{e.vendor ?? "—"}</td>
              <td>{accountName(e.accountId)}</td>
              <td className="money">{formatMoney(e.amountCents)}</td>
            </Row>
          ))}
        </Table>
      ) : null}
    </div>
  );
}

function Accounts() {
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState("expense");

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<{ accounts: Account[] }>("/api/accounts"),
  });

  const add = useMutation({
    mutationFn: () =>
      api("/api/accounts", {
        method: "POST",
        body: JSON.stringify({ code, name, type }),
      }),
    onSuccess: () => {
      setCode("");
      setName("");
      qc.invalidateQueries({ queryKey: ["accounts"] });
    },
  });

  if (accounts.isLoading) return <Loading />;
  if (accounts.error) return <ErrorNote error={accounts.error} />;
  const rows = [...(accounts.data?.accounts ?? [])].sort((a, b) =>
    a.code.localeCompare(b.code),
  );

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
        <p className="mt-2 text-xs" style={muted}>
          The accounts Sentrello needs are created for you the first time they
          are used. Add your own when you want the detail.
        </p>
        {add.error ? <ErrorNote error={add.error} /> : null}
      </Card>

      {rows.length === 0 ? (
        <Empty title="No accounts yet" />
      ) : (
        <Table headers={["Code", "Name", "Type"]}>
          {rows.map((a) => (
            <Row key={a.id}>
              <td className="py-2 font-medium">{a.code}</td>
              <td>{a.name}</td>
              <td style={muted}>{a.type}</td>
            </Row>
          ))}
        </Table>
      )}
    </div>
  );
}
