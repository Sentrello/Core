import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Contact, api } from "../lib/api";
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
  formatMoney,
  muted,
} from "../lib/ui";

interface Quote {
  id: string;
  number: string;
  status: string;
  currency: string;
  totalCents: number;
  contactId: string | null;
}

const emptyLine = (): Line => ({
  description: "",
  quantity: 1,
  unitPrice: 0,
  taxRateBp: 0,
});

export function Quotes() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);

  const quotes = useQuery({
    queryKey: ["quotes"],
    queryFn: () => api<{ quotes: Quote[] }>("/api/quotes"),
  });
  const contacts = useQuery({
    queryKey: ["contacts"],
    queryFn: () => api<{ contacts: Contact[] }>("/api/contacts"),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["quotes"] });
    qc.invalidateQueries({ queryKey: ["invoices"] });
  };

  const send = useMutation({
    mutationFn: (id: string) =>
      api(`/api/quotes/${id}/send`, { method: "POST" }),
    onSuccess: refresh,
  });

  const convert = useMutation({
    mutationFn: (id: string) =>
      api(`/api/quotes/${id}/convert`, { method: "POST" }),
    onSuccess: refresh,
  });

  if (quotes.isLoading) return <Loading />;
  if (quotes.error) return <ErrorNote error={quotes.error} />;

  const rows = quotes.data?.quotes ?? [];
  const nameFor = (id: string | null) =>
    contacts.data?.contacts.find((c) => c.id === id)?.name ?? "—";

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreating((v) => !v)}>
          {creating ? "Cancel" : "New quote"}
        </Button>
      </div>

      {creating ? (
        <NewQuote
          contacts={contacts.data?.contacts ?? []}
          onDone={() => {
            setCreating(false);
            refresh();
          }}
        />
      ) : null}

      {rows.length === 0 ? (
        <Empty title="No quotes yet">
          Price the work first. Sending a quote puts it on the customer's own
          page, where accepting it raises the invoice for you.
        </Empty>
      ) : (
        <Table
          headers={[
            "Number",
            "Customer",
            "Status",
            { label: "Total", money: true },
            "",
          ]}
        >
          {rows.map((q) => (
            <Row key={q.id}>
              <td className="py-2 font-medium">{q.number}</td>
              <td>{nameFor(q.contactId)}</td>
              <td>
                <StatusBadge status={q.status} />
              </td>
              <td className="money">{formatMoney(q.totalCents, q.currency)}</td>
              <td className="text-right">
                <div className="flex justify-end gap-2">
                  {q.status === "draft" || q.status === "sent" ? (
                    <Button
                      variant="secondary"
                      onClick={() => send.mutate(q.id)}
                      disabled={send.isPending}
                    >
                      {q.status === "sent" ? "Send again" : "Send"}
                    </Button>
                  ) : null}
                  {q.status !== "accepted" ? (
                    // The customer accepting is the normal path; this is for
                    // the ones agreed on the phone.
                    <Button
                      onClick={() => convert.mutate(q.id)}
                      disabled={convert.isPending}
                    >
                      Invoice it
                    </Button>
                  ) : null}
                </div>
              </td>
            </Row>
          ))}
        </Table>
      )}

      {send.error ? <ErrorNote error={send.error} /> : null}
      {convert.error ? <ErrorNote error={convert.error} /> : null}
    </div>
  );
}

function NewQuote({
  contacts,
  onDone,
}: {
  contacts: Contact[];
  onDone: () => void;
}) {
  const [contactId, setContactId] = useState("");
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const t = totals(lines);

  const create = useMutation({
    mutationFn: () =>
      api("/api/quotes", {
        method: "POST",
        body: JSON.stringify({
          contactId: contactId || null,
          currency: "USD",
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
          {create.isPending ? "Saving…" : "Create quote"}
        </Button>
      </div>
      {create.error ? <ErrorNote error={create.error} /> : null}
    </Card>
  );
}
