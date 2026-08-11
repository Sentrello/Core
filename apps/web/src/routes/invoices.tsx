import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Contact, type Invoice, api } from "../lib/api";
import { type Line, toAmountInput, toCents, totals } from "../lib/money";
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

const emptyLine = (): Line => ({
  description: "",
  quantity: 1,
  unitPrice: 0,
  taxRateBp: 0,
});

export function Invoices() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState<Invoice | null>(null);

  const invoices = useQuery({
    queryKey: ["invoices"],
    queryFn: () => api<{ invoices: Invoice[] }>("/api/invoices"),
  });
  const contacts = useQuery({
    queryKey: ["contacts"],
    queryFn: () => api<{ contacts: Contact[] }>("/api/contacts"),
  });

  const nameFor = (id: string | null) =>
    contacts.data?.contacts.find((c) => c.id === id)?.name ?? "—";

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["invoices"] });
    qc.invalidateQueries({ queryKey: ["profit-and-loss"] });
  };

  if (invoices.isLoading) return <Loading />;
  if (invoices.error) return <ErrorNote error={invoices.error} />;
  const rows = invoices.data?.invoices ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreating((v) => !v)}>
          {creating ? "Cancel" : "New invoice"}
        </Button>
      </div>

      {creating ? (
        <NewInvoice
          contacts={contacts.data?.contacts ?? []}
          onDone={() => {
            setCreating(false);
            refresh();
          }}
        />
      ) : null}

      {paying ? (
        <RecordPayment
          invoice={paying}
          onDone={() => {
            setPaying(null);
            refresh();
          }}
        />
      ) : null}

      {rows.length === 0 ? (
        <Empty title="No invoices yet">
          Invoices you raise will appear here, and post to the ledger as you
          issue them.
        </Empty>
      ) : (
        <Table
          headers={[
            "Number",
            "Customer",
            "Due",
            "Status",
            { label: "Total", money: true },
            "",
          ]}
        >
          {rows.map((inv) => (
            <Row key={inv.id}>
              <td className="py-2 font-medium">{inv.number}</td>
              <td>{nameFor(inv.contactId)}</td>
              <td>{formatDate(inv.dueDate)}</td>
              <td>
                <StatusBadge status={inv.status} />
              </td>
              <td className="money">
                {formatMoney(inv.totalCents, inv.currency)}
              </td>
              <td className="text-right">
                {inv.status !== "paid" ? (
                  <Button variant="secondary" onClick={() => setPaying(inv)}>
                    Record payment
                  </Button>
                ) : null}
              </td>
            </Row>
          ))}
        </Table>
      )}
    </div>
  );
}

function NewInvoice({
  contacts,
  onDone,
}: {
  contacts: Contact[];
  onDone: () => void;
}) {
  const [contactId, setContactId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const t = totals(lines);

  const create = useMutation({
    mutationFn: () =>
      api<{ invoice: Invoice }>("/api/invoices", {
        method: "POST",
        body: JSON.stringify({
          contactId: contactId || null,
          currency: "USD",
          dueDate: dueDate || null,
          lines: lines
            .filter((l) => l.description.trim())
            .map((l) => ({
              description: l.description,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              taxRateBp: l.taxRateBp,
            })),
        }),
      }),
    onSuccess: onDone,
  });

  const update = (i: number, patch: Partial<Line>) =>
    setLines((prev) =>
      prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)),
    );

  return (
    <Card>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Customer">
          <Select
            value={contactId}
            onChange={(e) => setContactId(e.target.value)}
          >
            <option value="">Select a contact…</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Due date">
          <Input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </Field>
      </div>

      <div className="mt-4 space-y-2">
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id until saved
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_5rem_7rem_6rem]">
            <Input
              placeholder="Description"
              value={line.description}
              onChange={(e) => update(i, { description: e.target.value })}
            />
            <Input
              type="number"
              min="0"
              step="1"
              value={line.quantity}
              onChange={(e) =>
                update(i, { quantity: Number(e.target.value) || 0 })
              }
            />
            <Input
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={toAmountInput(line.unitPrice)}
              onChange={(e) =>
                update(i, { unitPrice: toCents(e.target.value) })
              }
            />
            <Input
              type="number"
              min="0"
              step="0.01"
              placeholder="Tax %"
              value={line.taxRateBp ? line.taxRateBp / 100 : ""}
              onChange={(e) =>
                update(i, {
                  taxRateBp: Math.round(
                    (Number.parseFloat(e.target.value) || 0) * 100,
                  ),
                })
              }
            />
          </div>
        ))}
        <Button
          variant="secondary"
          onClick={() => setLines((prev) => [...prev, emptyLine()])}
        >
          Add line
        </Button>
      </div>

      <div className="mt-4 flex items-end justify-between">
        <dl className="text-sm">
          <div className="flex gap-4">
            <dt style={muted}>Subtotal</dt>
            <dd className="money">{formatMoney(t.subtotal)}</dd>
          </div>
          <div className="flex gap-4">
            <dt style={muted}>Tax</dt>
            <dd className="money">{formatMoney(t.tax)}</dd>
          </div>
          <div className="flex gap-4 font-semibold">
            <dt>Total</dt>
            <dd className="money">{formatMoney(t.total)}</dd>
          </div>
        </dl>
        <Button
          onClick={() => create.mutate()}
          disabled={
            create.isPending || !lines.some((l) => l.description.trim())
          }
        >
          {create.isPending ? "Saving…" : "Create invoice"}
        </Button>
      </div>
      {create.error ? <ErrorNote error={create.error} /> : null}
    </Card>
  );
}

function RecordPayment({
  invoice,
  onDone,
}: {
  invoice: Invoice;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState(String(invoice.totalCents / 100));
  const [method, setMethod] = useState("manual");

  const pay = useMutation({
    mutationFn: () =>
      api(`/api/invoices/${invoice.id}/payments`, {
        method: "POST",
        body: JSON.stringify({ amountCents: toCents(amount), method }),
      }),
    onSuccess: onDone,
  });

  return (
    <Card>
      <p className="mb-3 text-sm font-medium">
        Payment for {invoice.number} — {formatMoney(invoice.totalCents)} due
      </p>
      <div className="grid gap-3 sm:grid-cols-[10rem_10rem_auto]">
        <Field label="Amount">
          <Input
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="Method">
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="manual">Manual</option>
            <option value="bank">Bank transfer</option>
            <option value="cash">Cash</option>
            <option value="card">Card</option>
          </Select>
        </Field>
        <div className="flex items-end gap-2">
          <Button onClick={() => pay.mutate()} disabled={pay.isPending}>
            {pay.isPending ? "Saving…" : "Record"}
          </Button>
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </div>
      <p className="mt-2 text-xs" style={muted}>
        Part payments are fine: the balance stays open and the ledger is posted
        either way.
      </p>
      {pay.error ? <ErrorNote error={pay.error} /> : null}
    </Card>
  );
}
