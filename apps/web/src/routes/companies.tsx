import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { RelatedLink, useNavigation } from "../lib/navigation";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  Row,
  Table,
  formatMoney,
  muted,
} from "../lib/ui";

interface Company {
  id: string;
  name: string;
  sector: string | null;
  size: number | null;
  city: string | null;
  country: string | null;
  phone: string | null;
  website: string | null;
  linkedinUrl: string | null;
  address: string | null;
  description: string | null;
}

interface Related {
  company: Company;
  contacts: { id: string; name: string; title: string | null }[];
  deals: { id: string; name: string; stage: string; amountCents: number }[];
  notes: { id: string; text: string; createdAt: string }[];
}

const CLOSED = new Set(["won", "lost"]);

export function Companies() {
  const qc = useQueryClient();
  const { open } = useNavigation();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [sector, setSector] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["companies"],
    queryFn: () => api<{ companies: Company[] }>("/api/companies"),
  });

  const create = useMutation({
    mutationFn: () =>
      api("/api/companies", {
        method: "POST",
        body: JSON.stringify({ name, sector: sector || null }),
      }),
    onSuccess: () => {
      setName("");
      setSector("");
      setAdding(false);
      qc.invalidateQueries({ queryKey: ["companies"] });
    },
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  const companies = data?.companies ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setAdding((v) => !v)}>
          {adding ? "Cancel" : "New company"}
        </Button>
      </div>

      {adding ? (
        <Card>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Sector" hint="Optional.">
              <Input
                value={sector}
                onChange={(e) => setSector(e.target.value)}
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

      {companies.length === 0 ? (
        <Empty title="No companies yet">
          A company groups the people who work there and the deals in flight.
        </Empty>
      ) : (
        <Table headers={["Name", "Sector", "Where", "Phone"]}>
          {companies.map((co) => (
            <Row key={co.id}>
              <td className="py-2 font-medium">
                <button
                  type="button"
                  className="underline-offset-2 hover:underline"
                  onClick={() =>
                    open({
                      moduleId: "companies",
                      recordId: co.id,
                      title: co.name,
                    })
                  }
                >
                  {co.name}
                </button>
              </td>
              <td style={muted}>{co.sector ?? "—"}</td>
              <td style={muted}>
                {[co.city, co.country].filter(Boolean).join(", ") || "—"}
              </td>
              <td>{co.phone ?? "—"}</td>
            </Row>
          ))}
        </Table>
      )}
    </div>
  );
}

/**
 * One company: who works there, what is in flight.
 *
 * The far side of the link on a contact. Following a company name to a list of
 * every company would be worse than not linking at all — it would look like a
 * connection and behave like a dead end.
 */
export function CompanyDetail() {
  const { current } = useNavigation();
  const id = current.recordId;

  const { data, isLoading, error } = useQuery({
    queryKey: ["company-related", id],
    queryFn: () => api<Related>(`/api/companies/${id}/related`),
    enabled: Boolean(id),
  });

  if (!id) return <Empty title="No company selected" />;
  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const { company, contacts, deals } = data;
  const open = deals.filter((d) => !CLOSED.has(d.stage));
  const inFlight = open.reduce((sum, d) => sum + d.amountCents, 0);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-4">
        <Card>
          <p className="text-lg font-semibold">{company.name}</p>
          <p className="text-sm" style={muted}>
            {[
              company.sector,
              company.size ? `${company.size} people` : null,
              [company.city, company.country].filter(Boolean).join(", ") ||
                null,
            ]
              .filter(Boolean)
              .join(" · ") || "No details recorded"}
          </p>

          {company.description ? (
            <p className="mt-3 text-sm">{company.description}</p>
          ) : null}

          <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            {company.phone ? (
              <p>
                <span style={muted}>Phone: </span>
                <a href={`tel:${company.phone}`} className="underline">
                  {company.phone}
                </a>
              </p>
            ) : null}
            {company.website ? (
              <p>
                <span style={muted}>Web: </span>
                <a
                  href={company.website}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  {company.website}
                </a>
              </p>
            ) : null}
            {company.address ? (
              <p className="whitespace-pre-wrap sm:col-span-2">
                <span style={muted}>Address: </span>
                {company.address}
              </p>
            ) : null}
          </div>
        </Card>

        <Card>
          <p className="mb-2 font-medium">People here</p>
          {contacts.length === 0 ? (
            <p className="text-sm" style={muted}>
              Nobody recorded at this company yet.
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

      <Card>
        <p className="mb-1 font-medium">Deals</p>
        {/* The number a business actually wants off this screen: what is on the
            table with this customer right now. */}
        <p className="mb-2 text-sm" style={muted}>
          {open.length} open · {formatMoney(inFlight)} in flight
        </p>
        {deals.length === 0 ? (
          <p className="text-sm" style={muted}>
            Nothing in the pipeline.
          </p>
        ) : (
          <div className="space-y-2">
            {deals.map((d) => (
              <div key={d.id} className="text-sm">
                <RelatedLink
                  to={{ moduleId: "deals", recordId: d.id, title: d.name }}
                >
                  {d.name}
                </RelatedLink>
                <div className="text-xs" style={muted}>
                  {d.stage} · {formatMoney(d.amountCents)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
