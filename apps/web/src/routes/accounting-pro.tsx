import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Account, api } from "../lib/api";
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
  StatusBadge,
  Table,
  formatDate,
  formatMoney,
  muted,
} from "../lib/ui";

/**
 * The half of Accounting a licence pays for.
 *
 * Bills, banking and budgets, on the same nav entry and the same ledger as the
 * Free half. A business that upgrades finds more of the screen it already
 * knows, not a second Accounting somewhere else.
 */

type Bill = {
  id: string;
  number: string | null;
  vendorId: string | null;
  status: string;
  currency: string;
  billDate: string;
  dueDate: string | null;
  totalCents: number;
  paidCents: number;
  balanceDue: number;
  receiptFileKey: string | null;
};

type Vendor = { id: string; name: string };

type BillLine = {
  id: string;
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  taxRateBp: number;
  accountId: string | null;
};

type BillPayment = {
  id: string;
  amountCents: number;
  withheldCents: number;
  paidAt: string;
  method: string | null;
  reference: string | null;
};

type Schedule = {
  id: string;
  name: string | null;
  interval: string;
  intervalCount: number;
  nextRunAt: string;
  generatedCount: number;
  active: boolean;
  templateBillId: string;
};

/**
 * The paper behind a figure.
 *
 * An inspector, an accountant and a bank all ask for the receipt rather than
 * the entry, so a row that has one says so and hands it over, and a row that
 * has none offers to take it.
 */
export function Receipt({
  holder,
  id,
  has,
  onDone,
}: {
  holder: "transactions" | "bills";
  id: string;
  has: boolean;
  onDone: () => void;
}) {
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      // No content-type header: FormData sets its own with the boundary, and
      // overriding it makes the body unparseable at the other end.
      const res = await fetch(`/api/${holder}/${id}/receipt`, {
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

  if (has) {
    return (
      <a
        className="text-xs underline"
        href={`/api/${holder}/${id}/receipt`}
        style={muted}
      >
        Receipt
      </a>
    );
  }
  return (
    <label className="cursor-pointer text-xs underline" style={muted}>
      {upload.isPending ? "Attaching…" : "Attach"}
      <input
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) upload.mutate(file);
        }}
      />
    </label>
  );
}

/**
 * What a bill is actually made of.
 *
 * The list answers "what do we owe"; this answers "what for, and what have we
 * already paid" — which is the question somebody has open when the supplier
 * telephones.
 */
function BillDetail({ id }: { id: string }) {
  const detail = useQuery({
    queryKey: ["bill", id],
    queryFn: () =>
      api<{ lines: BillLine[]; payments: BillPayment[] }>(`/api/bills/${id}`),
  });

  if (detail.isLoading) return <Loading />;
  if (detail.error) return <ErrorNote error={detail.error} />;
  const { lines = [], payments = [] } = detail.data ?? {};

  return (
    <div className="space-y-3 px-2 py-3">
      <Table
        headers={[
          "Line",
          "Quantity",
          { label: "Each", money: true },
          "Tax",
          { label: "Line total", money: true },
        ]}
      >
        {lines.map((line) => (
          <Row key={line.id}>
            <td className="py-2">{line.description}</td>
            <td style={muted}>{line.quantityMilli / 1000}</td>
            <td className="money">{formatMoney(line.unitPriceCents)}</td>
            <td style={muted}>
              {line.taxRateBp ? `${(line.taxRateBp / 100).toFixed(2)}%` : "—"}
            </td>
            <td className="money">
              {formatMoney(
                Math.round((line.quantityMilli / 1000) * line.unitPriceCents),
              )}
            </td>
          </Row>
        ))}
      </Table>

      {payments.length > 0 ? (
        <Table
          headers={[
            "Paid",
            { label: "Amount", money: true },
            { label: "Withheld", money: true },
            "How",
          ]}
        >
          {payments.map((payment) => (
            <Row key={payment.id}>
              <td className="py-2">{formatDate(payment.paidAt)}</td>
              <td className="money">{formatMoney(payment.amountCents)}</td>
              <td className="money">
                {payment.withheldCents
                  ? formatMoney(payment.withheldCents)
                  : "—"}
              </td>
              <td style={muted}>{payment.method ?? "—"}</td>
            </Row>
          ))}
        </Table>
      ) : (
        <p className="text-xs" style={muted}>
          Nothing paid against it yet.
        </p>
      )}
    </div>
  );
}

export function Bills() {
  const qc = useQueryClient();
  const [number, setNumber] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const bills = useQuery({
    queryKey: ["bills"],
    queryFn: () => api<{ bills: Bill[] }>("/api/bills"),
  });
  const vendors = useQuery({
    queryKey: ["vendors"],
    queryFn: () => api<{ vendors: Vendor[] }>("/api/bills/vendors"),
  });
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<{ accounts: Account[] }>("/api/accounts"),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["bills"] });
    qc.invalidateQueries({ queryKey: ["profit-and-loss"] });
    qc.invalidateQueries({ queryKey: ["balance-sheet"] });
    qc.invalidateQueries({ queryKey: ["journal"] });
  };

  const add = useMutation({
    mutationFn: () =>
      api("/api/bills", {
        method: "POST",
        body: JSON.stringify({
          number: number || null,
          vendorId: vendorId || null,
          dueDate: dueDate || null,
          lines: [
            {
              description: description || "Bill",
              unitPriceCents: toCents(amount),
              accountId: accountId || null,
            },
          ],
        }),
      }),
    onSuccess: () => {
      setNumber("");
      setDescription("");
      setAmount("");
      refresh();
    },
  });

  const approve = useMutation({
    mutationFn: (id: string) =>
      api(`/api/bills/${id}/approve`, { method: "POST" }),
    onSuccess: refresh,
  });

  const pay = useMutation({
    mutationFn: (input: { id: string; amountCents: number }) =>
      api(`/api/bills/${input.id}/payments`, {
        method: "POST",
        body: JSON.stringify({ amountCents: input.amountCents }),
      }),
    onSuccess: refresh,
  });

  const voidBill = useMutation({
    mutationFn: (id: string) =>
      api(`/api/bills/${id}/void`, { method: "POST" }),
    onSuccess: refresh,
  });

  const schedules = useQuery({
    queryKey: ["recurring-bills"],
    queryFn: () => api<{ schedules: Schedule[] }>("/api/recurring-bills"),
  });

  /**
   * Repeating a bill means pointing a schedule at the one on the screen.
   *
   * The bill itself is the template — a real draft somebody can open and
   * correct — rather than a form of its own, for the same reason recurring
   * invoices work that way: what arrives each month is a document, and it
   * should be edited with the screen that edits documents.
   */
  const repeat = useMutation({
    mutationFn: (input: { id: string; interval: string }) =>
      api("/api/recurring-bills", {
        method: "POST",
        body: JSON.stringify({
          templateBillId: input.id,
          interval: input.interval,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recurring-bills"] });
    },
  });

  const stop = useMutation({
    mutationFn: (input: { id: string; active: boolean }) =>
      api(`/api/recurring-bills/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: input.active }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recurring-bills"] }),
  });

  const vendorName = (id: string | null) =>
    vendors.data?.vendors.find((v) => v.id === id)?.name ?? "—";

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-3 sm:grid-cols-[9rem_1fr_1fr_8rem_1fr_9rem_auto]">
          <Field label="Their reference">
            <Input
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="SUP-1042"
            />
          </Field>
          <Field label="Supplier">
            <Select
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
            >
              <option value="">Not recorded</option>
              {(vendors.data?.vendors ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="For">
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
              <option value="">General expenses</option>
              {(accounts.data?.accounts ?? [])
                .filter((a) => a.type === "expense")
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Due">
            <Input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
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
        <p className="mt-2 text-xs" style={muted}>
          A bill is a draft until you approve it. Nothing reaches the books
          before that, so a mistyped draft costs nothing to throw away.
        </p>
        {add.error ? <ErrorNote error={add.error} /> : null}
      </Card>

      {bills.isLoading ? <Loading /> : null}
      {bills.error ? <ErrorNote error={bills.error} /> : null}
      {bills.data && bills.data.bills.length === 0 ? (
        <Empty title="No bills yet">
          What your suppliers ask you for goes here, and into Accounts Payable
          once you approve it.
        </Empty>
      ) : null}
      {bills.data && bills.data.bills.length > 0 ? (
        <Table
          headers={[
            "Date",
            "Supplier",
            "Reference",
            "Status",
            { label: "Total", money: true },
            { label: "Owing", money: true },
            "Receipt",
            "",
          ]}
        >
          {bills.data.bills.map((bill) => (
            <Row key={bill.id}>
              <td className="py-2">{formatDate(bill.billDate)}</td>
              <td>
                <button
                  type="button"
                  className="underline"
                  onClick={() => setOpen(open === bill.id ? null : bill.id)}
                >
                  {vendorName(bill.vendorId)}
                </button>
              </td>
              <td style={muted}>{bill.number ?? "—"}</td>
              <td>
                <StatusBadge status={bill.status} />
              </td>
              <td className="money">
                {formatMoney(bill.totalCents, bill.currency)}
              </td>
              <td className="money">
                {formatMoney(bill.balanceDue, bill.currency)}
              </td>
              <td>
                <Receipt
                  holder="bills"
                  id={bill.id}
                  has={Boolean(bill.receiptFileKey)}
                  onDone={refresh}
                />
              </td>
              <td className="space-x-2 text-xs">
                {bill.status === "draft" ? (
                  <button
                    type="button"
                    className="underline"
                    onClick={() => approve.mutate(bill.id)}
                  >
                    Approve
                  </button>
                ) : null}
                {bill.balanceDue > 0 && bill.status !== "draft" ? (
                  <button
                    type="button"
                    className="underline"
                    onClick={() =>
                      pay.mutate({ id: bill.id, amountCents: bill.balanceDue })
                    }
                  >
                    Pay in full
                  </button>
                ) : null}
                {schedules.data?.schedules.some(
                  (s) => s.templateBillId === bill.id,
                ) ? null : (
                  <button
                    type="button"
                    className="underline"
                    style={muted}
                    onClick={() =>
                      repeat.mutate({ id: bill.id, interval: "monthly" })
                    }
                  >
                    Repeat monthly
                  </button>
                )}
                {bill.status !== "void" && bill.paidCents === 0 ? (
                  <button
                    type="button"
                    className="underline"
                    style={muted}
                    onClick={() => voidBill.mutate(bill.id)}
                  >
                    Void
                  </button>
                ) : null}
              </td>
            </Row>
          ))}
        </Table>
      ) : null}
      {open ? (
        <Card>
          <p className="mb-1 text-sm font-medium">
            {bills.data?.bills.find((b) => b.id === open)?.number ??
              "This bill"}{" "}
            <button
              type="button"
              className="ml-2 text-xs underline"
              style={muted}
              onClick={() => setOpen(null)}
            >
              close
            </button>
          </p>
          <BillDetail id={open} />
        </Card>
      ) : null}

      {schedules.data && schedules.data.schedules.length > 0 ? (
        <Card>
          <p className="mb-2 text-sm font-medium">Bills that repeat</p>
          <Table headers={["What", "How often", "Next", "Raised so far", ""]}>
            {schedules.data.schedules.map((s) => (
              <Row key={s.id}>
                <td className="py-2">{s.name ?? "Repeating bill"}</td>
                <td style={muted}>
                  {s.intervalCount > 1
                    ? `every ${s.intervalCount} ${s.interval}`
                    : s.interval}
                </td>
                <td>{s.active ? formatDate(s.nextRunAt) : "stopped"}</td>
                <td style={muted}>{s.generatedCount}</td>
                <td>
                  <button
                    type="button"
                    className="text-xs underline"
                    style={muted}
                    onClick={() => stop.mutate({ id: s.id, active: !s.active })}
                  >
                    {s.active ? "Stop" : "Start again"}
                  </button>
                </td>
              </Row>
            ))}
          </Table>
          <p className="mt-2 text-xs" style={muted}>
            Each run copies the bill it points at into a new draft. Nothing is
            approved for you — a bill is somebody else's claim, and the figure
            is often not last month's.
          </p>
          {stop.error ? <ErrorNote error={stop.error} /> : null}
        </Card>
      ) : null}

      {approve.error ? <ErrorNote error={approve.error} /> : null}
      {pay.error ? <ErrorNote error={pay.error} /> : null}
      {repeat.error ? <ErrorNote error={repeat.error} /> : null}
      {voidBill.error ? <ErrorNote error={voidBill.error} /> : null}
    </div>
  );
}

type BankTransaction = {
  id: string;
  date: string;
  description: string | null;
  amountCents: number;
  matchedEntryId: string | null;
};

type Suggestion = {
  bankTransactionId: string;
  amountCents: number;
  date: string;
  candidates: {
    kind: "invoice" | "bill";
    id: string;
    number: string | null;
    balanceDue: number;
  }[];
};

/**
 * The bank, and making it agree with the books.
 *
 * Every match is confirmed by a person. A wrong automatic match is a wrong
 * ledger, and a wrong ledger found six months later costs far more than the
 * typing it saved.
 */
export function Banking() {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [fromAccountId, setFrom] = useState("");
  const [toAccountId, setTo] = useState("");
  const [amount, setAmount] = useState("");

  const rows = useQuery({
    queryKey: ["bank-transactions"],
    queryFn: () =>
      api<{ bankTransactions: BankTransaction[]; unmatchedCount: number }>(
        "/api/bank-transactions",
      ),
  });
  const suggestions = useQuery({
    queryKey: ["bank-suggestions"],
    queryFn: () =>
      api<{ suggestions: Suggestion[] }>("/api/bank-transactions/suggestions"),
  });
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<{ accounts: Account[] }>("/api/accounts"),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["bank-transactions"] });
    qc.invalidateQueries({ queryKey: ["bank-suggestions"] });
    qc.invalidateQueries({ queryKey: ["journal"] });
    qc.invalidateQueries({ queryKey: ["balance-sheet"] });
  };

  const importCsv = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("choose a file first");
      return api(
        `/api/bank-imports?filename=${encodeURIComponent(file.name)}`,
        { method: "POST", body: await file.text() },
      );
    },
    onSuccess: () => {
      setFile(null);
      refresh();
    },
  });

  const match = useMutation({
    mutationFn: (input: {
      id: string;
      kind: "invoice" | "bill";
      refId: string;
    }) =>
      api(`/api/bank-transactions/${input.id}/match`, {
        method: "POST",
        body: JSON.stringify(
          input.kind === "invoice"
            ? { invoiceId: input.refId }
            : { billId: input.refId },
        ),
      }),
    onSuccess: () => {
      refresh();
      qc.invalidateQueries({ queryKey: ["bills"] });
    },
  });

  const transfer = useMutation({
    mutationFn: () =>
      api("/api/transfers", {
        method: "POST",
        body: JSON.stringify({
          fromAccountId,
          toAccountId,
          amountCents: toCents(amount),
        }),
      }),
    onSuccess: () => {
      setAmount("");
      refresh();
    },
  });

  const assets = (accounts.data?.accounts ?? []).filter(
    (a) => a.type === "asset",
  );

  return (
    <div className="space-y-4">
      <Card>
        <p className="mb-2 text-sm font-medium">Import a statement</p>
        <div className="flex items-end gap-3">
          <input
            type="file"
            accept=".csv,text/csv"
            className="text-sm"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <Button
            onClick={() => importCsv.mutate()}
            disabled={!file || importCsv.isPending}
          >
            Import
          </Button>
        </div>
        <p className="mt-2 text-xs" style={muted}>
          Rows whose date or amount cannot be read are reported back rather than
          imported as nothing.
        </p>
        {importCsv.error ? <ErrorNote error={importCsv.error} /> : null}
      </Card>

      <Card>
        <p className="mb-2 text-sm font-medium">Move money between accounts</p>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_8rem_auto]">
          <Field label="From">
            <Select
              value={fromAccountId}
              onChange={(e) => setFrom(e.target.value)}
            >
              <option value="">Choose</option>
              {assets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="To">
            <Select value={toAccountId} onChange={(e) => setTo(e.target.value)}>
              <option value="">Choose</option>
              {assets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </Select>
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
          <div className="flex items-end">
            <Button
              onClick={() => transfer.mutate()}
              disabled={
                transfer.isPending || !amount || !fromAccountId || !toAccountId
              }
            >
              Transfer
            </Button>
          </div>
        </div>
        {transfer.error ? <ErrorNote error={transfer.error} /> : null}
      </Card>

      {suggestions.data && suggestions.data.suggestions.length > 0 ? (
        <Card>
          <p className="mb-2 text-sm font-medium">
            These look like they settle something
          </p>
          {suggestions.data.suggestions.map((s) => (
            <div
              key={s.bankTransactionId}
              className="flex items-center justify-between border-b py-2 text-sm last:border-0"
            >
              <span>
                {formatDate(s.date)} &middot;{" "}
                <span className="money">{formatMoney(s.amountCents)}</span>
              </span>
              <span className="space-x-2">
                {s.candidates.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className="text-xs underline"
                    onClick={() =>
                      match.mutate({
                        id: s.bankTransactionId,
                        kind: candidate.kind,
                        refId: candidate.id,
                      })
                    }
                  >
                    {candidate.number ?? candidate.id.slice(0, 8)}
                  </button>
                ))}
              </span>
            </div>
          ))}
          {match.error ? <ErrorNote error={match.error} /> : null}
        </Card>
      ) : null}

      {rows.isLoading ? <Loading /> : null}
      {rows.error ? <ErrorNote error={rows.error} /> : null}
      {rows.data && rows.data.bankTransactions.length === 0 ? (
        <Empty title="No statement imported yet" />
      ) : null}
      {rows.data && rows.data.bankTransactions.length > 0 ? (
        <Table
          headers={[
            "Date",
            "Detail",
            { label: "Amount", money: true },
            "Reconciled",
          ]}
        >
          {rows.data.bankTransactions.map((row) => (
            <Row key={row.id}>
              <td className="py-2">{formatDate(row.date)}</td>
              <td>{row.description ?? "—"}</td>
              <td className="money">{formatMoney(row.amountCents)}</td>
              <td style={muted}>{row.matchedEntryId ? "yes" : "not yet"}</td>
            </Row>
          ))}
        </Table>
      ) : null}
    </div>
  );
}

type Budget = { id: string; name: string; year: number };

type StoredBudgetLine = {
  accountId: string;
  month: number;
  amountCents: number;
};

type BudgetRow = {
  accountId: string;
  code: string;
  name: string;
  budgetedCents: number;
  actualCents: number;
  varianceCents: number;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function Budgets() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [chosen, setChosen] = useState("");
  /** 0 is the whole year, which is how most small businesses budget. */
  const [month, setMonth] = useState(0);
  /** What has been typed but not yet saved, in whole currency units. */
  const [edits, setEdits] = useState<Record<string, string>>({});

  const budgets = useQuery({
    queryKey: ["budgets"],
    queryFn: () => api<{ budgets: Budget[] }>("/api/budgets"),
  });
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<{ accounts: Account[] }>("/api/accounts"),
  });

  const create = useMutation({
    mutationFn: () =>
      api("/api/budgets", {
        method: "POST",
        body: JSON.stringify({ name, year: Number(year) }),
      }),
    onSuccess: () => {
      setName("");
      qc.invalidateQueries({ queryKey: ["budgets"] });
    },
  });

  const id = chosen || budgets.data?.budgets[0]?.id || "";
  const actuals = useQuery({
    queryKey: ["budget-actuals", id, month],
    queryFn: () =>
      api<{
        budget: Budget;
        month: number | null;
        lines: StoredBudgetLine[];
        rows: BudgetRow[];
      }>(`/api/budgets/${id}/actuals${month ? `?month=${month}` : ""}`),
    enabled: Boolean(id),
  });

  /**
   * The whole grid is sent, not the row that changed.
   *
   * A budget is read as a set of figures that add up to a plan, and a
   * half-applied grid is a plan nobody typed — so the server replaces the lot.
   * Which means the screen has to send back the months it is not showing:
   * editing March must not quietly delete the figure somebody set for the
   * year, or for April.
   */
  const save = useMutation({
    mutationFn: () => {
      const untouched = (actuals.data?.lines ?? []).filter(
        (line) => line.month !== month || !(line.accountId in edits),
      );
      const changed = Object.entries(edits)
        .map(([accountId, value]) => ({
          accountId,
          month,
          amountCents: toCents(value),
        }))
        .filter((line) => line.amountCents > 0);
      return api(`/api/budgets/${id}/lines`, {
        method: "PUT",
        body: JSON.stringify({ lines: [...untouched, ...changed] }),
      });
    },
    onSuccess: () => {
      setEdits({});
      qc.invalidateQueries({ queryKey: ["budget-actuals", id] });
    },
  });

  /** Every account worth budgeting for, with whatever is already set on it. */
  const budgetable = (accounts.data?.accounts ?? []).filter(
    (account) => account.type === "expense" || account.type === "income",
  );
  /** What is stored against the period on screen, not what is derived for it. */
  const storedFor = (accountId: string) =>
    (actuals.data?.lines ?? [])
      .filter((line) => line.accountId === accountId && line.month === month)
      .reduce((sum, line) => sum + line.amountCents, 0);
  const budgetedFor = (accountId: string) =>
    actuals.data?.rows.find((row) => row.accountId === accountId)
      ?.budgetedCents ?? 0;
  const actualFor = (accountId: string) =>
    actuals.data?.rows.find((row) => row.accountId === accountId)
      ?.actualCents ?? 0;
  const valueFor = (accountId: string) =>
    edits[accountId] ??
    (storedFor(accountId) ? (storedFor(accountId) / 100).toFixed(2) : "");

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-3 sm:grid-cols-[1fr_7rem_auto]">
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Operating budget"
            />
          </Field>
          <Field label="Year">
            <Input value={year} onChange={(e) => setYear(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button
              onClick={() => create.mutate()}
              disabled={create.isPending || !name}
            >
              Create
            </Button>
          </div>
        </div>
        {create.error ? <ErrorNote error={create.error} /> : null}
      </Card>

      {id ? (
        <Card>
          <div className="grid gap-3 sm:grid-cols-2">
            {budgets.data && budgets.data.budgets.length > 1 ? (
              <Field label="Budget">
                <Select
                  value={id}
                  onChange={(e) => {
                    setChosen(e.target.value);
                    setEdits({});
                  }}
                >
                  {budgets.data.budgets.map((budget) => (
                    <option key={budget.id} value={budget.id}>
                      {budget.name} ({budget.year})
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label="Period">
              <Select
                value={String(month)}
                onChange={(e) => {
                  setMonth(Number(e.target.value));
                  setEdits({});
                }}
              >
                <option value="0">The whole year</option>
                {MONTHS.map((label, i) => (
                  <option key={label} value={i + 1}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>
      ) : null}

      {!id ? (
        <Empty title="No budget yet">
          Create one, then set a figure against the accounts you plan by.
        </Empty>
      ) : null}
      {actuals.isLoading && id ? <Loading /> : null}
      {actuals.error ? <ErrorNote error={actuals.error} /> : null}

      {id && budgetable.length > 0 ? (
        <Card>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium">
              {actuals.data?.budget.name ?? "Budget"} —{" "}
              {month ? `${MONTHS[month - 1]} ` : ""}
              {actuals.data?.budget.year ?? year}
            </p>
            <Button
              onClick={() => save.mutate()}
              disabled={save.isPending || Object.keys(edits).length === 0}
            >
              Save figures
            </Button>
          </div>
          <Table
            headers={[
              "Code",
              "Account",
              {
                label: month
                  ? `Budget for ${MONTHS[month - 1]}`
                  : "Budget for the year",
                money: true,
              },
              { label: "Allowed", money: true },
              { label: "Actual", money: true },
              { label: "Left", money: true },
            ]}
          >
            {budgetable.map((account) => {
              const spent = actualFor(account.id);
              const allowed = edits[account.id]
                ? budgetedFor(account.id) -
                  storedFor(account.id) +
                  toCents(edits[account.id] as string)
                : budgetedFor(account.id);
              return (
                <Row key={account.id}>
                  <td className="py-2 font-medium">{account.code}</td>
                  <td>{account.name}</td>
                  <td>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={valueFor(account.id)}
                      onChange={(e) =>
                        setEdits({ ...edits, [account.id]: e.target.value })
                      }
                    />
                  </td>
                  <td className="money">{formatMoney(allowed)}</td>
                  <td className="money">{formatMoney(spent)}</td>
                  <td
                    className="money"
                    style={
                      allowed > 0 && allowed - spent < 0
                        ? { color: "var(--color-danger)" }
                        : undefined
                    }
                  >
                    {allowed > 0 ? formatMoney(allowed - spent) : "—"}
                  </td>
                </Row>
              );
            })}
          </Table>
          <p className="mt-2 text-xs" style={muted}>
            {month
              ? `A figure here is for ${MONTHS[month - 1]} alone. "Allowed" adds a twelfth of anything set for the whole year, because that is what a yearly figure means for one month of it.`
              : "A figure here is for the whole year. The actuals beside it are what the ledger says happened in it."}
          </p>
          {save.error ? <ErrorNote error={save.error} /> : null}
        </Card>
      ) : null}
    </div>
  );
}
type BookTax = {
  id: string;
  name: string;
  rateBp: number;
  categoryCode: string;
  active: boolean;
  appliesTo: string;
  compound: boolean;
  withholding: boolean;
  recoverable: boolean;
  regime: string | null;
  jurisdiction: string | null;
};

type Rate = { id: string; code: string; rateMicro: number; asOf: string };

const REGIMES: { code: string; label: string }[] = [
  { code: "us", label: "United States" },
  { code: "ca", label: "Canada" },
  { code: "uk", label: "United Kingdom" },
  { code: "eu", label: "European Union" },
];

/** 875 → "8.75%". Rates are basis points everywhere they are stored. */
function asPercent(rateBp: number): string {
  return `${(rateBp / 100).toFixed(2).replace(/\.00$/, "")}%`;
}

/**
 * Tax and currency — the parts of both that only the books care about.
 *
 * The rate itself, its name and its category belong to Invoicing, because they
 * appear on a document. Whether a rate compounds, is withheld, or comes back on
 * a purchase changes the journal entry rather than the document, so it is set
 * here. One list of rates either way: two would be two answers to what the
 * standard rate is.
 */
/**
 * Closing the books to a date.
 *
 * Its own card on this screen rather than a hidden setting, because the thing
 * it prevents is invisible: until now anybody with invoicing permission could
 * post into a month that had already been reported on, and nothing anywhere
 * said so. A business that has filed a return needs those figures to stay
 * filed.
 */
function ClosingTheBooks() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);

  const period = useQuery({
    queryKey: ["accounting-period"],
    queryFn: () =>
      api<{ closedThrough: string | null }>("/api/accounting/period"),
  });

  const save = useMutation({
    mutationFn: (closedThrough: string | null) =>
      api("/api/accounting/period", {
        method: "PUT",
        body: JSON.stringify({ closedThrough }),
      }),
    onSuccess: () => {
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["accounting-period"] });
    },
  });

  const closed = period.data?.closedThrough ?? null;
  const value = draft ?? closed ?? "";

  return (
    <Card>
      <p className="mb-1 text-sm font-medium">Closing the books</p>
      <p className="mb-3 text-sm" style={muted}>
        {closed
          ? `Everything on or before ${closed} is closed. Nothing can be posted into it — no invoice, no payment, no expense — until the date is moved.`
          : "Nothing is closed. Anybody who can raise an invoice can post into a month you have already reported on, and nothing will say so."}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Closed through">
          <Input
            type="date"
            max={new Date().toISOString().slice(0, 10)}
            value={value}
            onChange={(e) => setDraft(e.target.value)}
          />
        </Field>
        <Button
          onClick={() => save.mutate(value || null)}
          disabled={save.isPending || value === (closed ?? "")}
        >
          {save.isPending ? "Saving…" : "Close to this date"}
        </Button>
        {closed ? (
          <Button
            variant="secondary"
            onClick={() => save.mutate(null)}
            disabled={save.isPending}
          >
            Reopen
          </Button>
        ) : null}
      </div>
      {/*
        Reopening is offered rather than hidden. An accountant asking for a
        correction in a closed month has to be possible, or the lock becomes
        something people avoid setting in the first place.
      */}
      {save.error ? <ErrorNote error={save.error} /> : null}
    </Card>
  );
}

export function TaxAndCurrency() {
  const qc = useQueryClient();
  const [regime, setRegime] = useState("uk");
  const [code, setCode] = useState("");
  const [rate, setRate] = useState("");

  const taxes = useQuery({
    queryKey: ["invoicing-taxes"],
    queryFn: () => api<{ taxes: BookTax[] }>("/api/invoicing/taxes"),
  });
  const currencies = useQuery({
    queryKey: ["currencies"],
    queryFn: () =>
      api<{ baseCurrency: string; rates: Rate[] }>(
        "/api/accounting/currencies",
      ),
  });

  const install = useMutation({
    mutationFn: () =>
      api("/api/accounting/taxes/presets", {
        method: "POST",
        body: JSON.stringify({ regime }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invoicing-taxes"] }),
  });

  const setFlag = useMutation({
    mutationFn: (input: { id: string; patch: Record<string, unknown> }) =>
      api(`/api/accounting/taxes/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify(input.patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invoicing-taxes"] }),
  });

  const addRate = useMutation({
    mutationFn: () =>
      api("/api/accounting/currencies", {
        method: "POST",
        body: JSON.stringify({
          code: code.trim().toUpperCase(),
          // Typed as a rate, stored in millionths: 1.0925 → 1_092_500.
          rateMicro: Math.round(Number(rate) * 1_000_000),
        }),
      }),
    onSuccess: () => {
      setCode("");
      setRate("");
      qc.invalidateQueries({ queryKey: ["currencies"] });
    },
  });

  const rows = (taxes.data?.taxes ?? []).filter((tax) => tax.active);

  return (
    <div className="space-y-4">
      <ClosingTheBooks />

      <Card>
        <p className="mb-2 text-sm font-medium">Start from a regime's rates</p>
        <div className="flex items-end gap-3">
          <Field label="Where you trade">
            <Select value={regime} onChange={(e) => setRegime(e.target.value)}>
              {REGIMES.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
          <Button onClick={() => install.mutate()} disabled={install.isPending}>
            Add these rates
          </Button>
        </div>
        <p className="mt-2 text-xs" style={muted}>
          Rates move, so these are a starting point you edit — nothing is ever
          added twice, and US sales tax has no national figure to ship.
        </p>
        {install.error ? <ErrorNote error={install.error} /> : null}
      </Card>

      {taxes.isLoading ? <Loading /> : null}
      {taxes.error ? <ErrorNote error={taxes.error} /> : null}
      {rows.length === 0 ? (
        <Empty title="No tax rates yet">
          Add a regime's rates above, or write your own on the invoice settings
          screen.
        </Empty>
      ) : (
        <Table
          headers={[
            "Rate",
            "Charged on",
            "Comes back",
            "Compound",
            "Withheld",
            "Where",
          ]}
        >
          {rows.map((tax) => (
            <Row key={tax.id}>
              <td className="py-2">
                <span className="font-medium">{tax.name}</span>{" "}
                <span style={muted}>{asPercent(tax.rateBp)}</span>
              </td>
              <td>
                <Select
                  value={tax.appliesTo}
                  onChange={(e) =>
                    setFlag.mutate({
                      id: tax.id,
                      patch: { appliesTo: e.target.value },
                    })
                  }
                >
                  <option value="both">sales and purchases</option>
                  <option value="sales">sales</option>
                  <option value="purchases">purchases</option>
                </Select>
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={tax.recoverable}
                  onChange={(e) =>
                    setFlag.mutate({
                      id: tax.id,
                      patch: { recoverable: e.target.checked },
                    })
                  }
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={tax.compound}
                  onChange={(e) =>
                    setFlag.mutate({
                      id: tax.id,
                      patch: { compound: e.target.checked },
                    })
                  }
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={tax.withholding}
                  onChange={(e) =>
                    setFlag.mutate({
                      id: tax.id,
                      patch: { withholding: e.target.checked },
                    })
                  }
                />
              </td>
              <td style={muted}>{tax.jurisdiction ?? "—"}</td>
            </Row>
          ))}
        </Table>
      )}
      <p className="text-xs" style={muted}>
        "Comes back" is what separates VAT and GST from US sales tax: tax you
        reclaim on a purchase is a debit against what you owe, and tax you
        cannot is part of what the thing cost.
      </p>
      {setFlag.error ? <ErrorNote error={setFlag.error} /> : null}

      <Card>
        <p className="mb-2 text-sm font-medium">
          Currency — the books are kept in{" "}
          {currencies.data?.baseCurrency ?? "…"}
        </p>
        <div className="grid gap-3 sm:grid-cols-[8rem_10rem_auto]">
          <Field label="Currency">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="EUR"
              maxLength={3}
            />
          </Field>
          <Field
            label={`1 unit is worth (${currencies.data?.baseCurrency ?? ""})`}
          >
            <Input
              type="number"
              step="0.000001"
              min="0"
              placeholder="1.085000"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          </Field>
          <div className="flex items-end">
            <Button
              onClick={() => addRate.mutate()}
              disabled={addRate.isPending || !code || !rate}
            >
              Record rate
            </Button>
          </div>
        </div>
        <p className="mt-2 text-xs" style={muted}>
          A document is converted at the rate recorded on or before its own
          date, so last year's accounts do not change when a rate does.
        </p>
        {addRate.error ? <ErrorNote error={addRate.error} /> : null}
      </Card>

      {currencies.data && currencies.data.rates.length > 0 ? (
        <Table headers={["Currency", { label: "Rate", money: false }, "As at"]}>
          {currencies.data.rates.map((r) => (
            <Row key={r.id}>
              <td className="py-2 font-medium">{r.code}</td>
              <td>{(r.rateMicro / 1_000_000).toFixed(6)}</td>
              <td style={muted}>{formatDate(r.asOf)}</td>
            </Row>
          ))}
        </Table>
      ) : null}
    </div>
  );
}
