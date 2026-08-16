import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type FormDefinition, api } from "../lib/api";
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
  muted,
} from "../lib/ui";
import { FormBuilder } from "./form-builder";

type FormRow = FormDefinition & { allowedOrigins: string[] };

export function Forms() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState("contact");
  const [showing, setShowing] = useState<FormRow | null>(null);
  const [building, setBuilding] = useState<FormRow | null>(null);
  const [viewing, setViewing] = useState<FormRow | null>(null);

  const forms = useQuery({
    queryKey: ["forms"],
    queryFn: () => api<{ forms: FormRow[] }>("/api/forms"),
  });

  const create = useMutation({
    mutationFn: () =>
      api("/api/forms", {
        method: "POST",
        body: JSON.stringify({ name: name || undefined, kind }),
      }),
    onSuccess: () => {
      setName("");
      qc.invalidateQueries({ queryKey: ["forms"] });
    },
  });

  if (forms.isLoading) return <Loading />;
  if (forms.error) return <ErrorNote error={forms.error} />;
  const rows = forms.data?.forms ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-3 sm:grid-cols-[1fr_9rem_auto]">
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Contact form"
            />
          </Field>
          <Field label="Type">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="contact">Contact</option>
              <option value="quote">Quote request</option>
            </Select>
          </Field>
          <div className="flex items-end">
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              New form
            </Button>
          </div>
        </div>
        {create.error ? <ErrorNote error={create.error} /> : null}
      </Card>

      {rows.length === 0 ? (
        <Empty title="No forms yet">
          A form gives you a snippet to paste into any website. Submissions
          become contacts here.
        </Empty>
      ) : (
        <Table headers={["Name", "Type", "Questions", "Allowed sites", ""]}>
          {rows.map((f) => (
            <Row key={f.id}>
              <td className="py-2 font-medium">{f.name}</td>
              <td style={muted}>
                {f.kind}
                {f.tag ? <span className="ml-1 text-xs">· {f.tag}</span> : null}
              </td>
              <td style={muted}>{f.fields?.length ?? 0}</td>
              <td style={muted}>
                {f.allowedOrigins?.length
                  ? f.allowedOrigins.join(", ")
                  : "this site only"}
              </td>
              <td className="text-right">
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={() => setViewing(f)}>
                    Submissions
                  </Button>
                  <Button variant="secondary" onClick={() => setBuilding(f)}>
                    Edit questions
                  </Button>
                  <Button variant="secondary" onClick={() => setShowing(f)}>
                    Embed code
                  </Button>
                </div>
              </td>
            </Row>
          ))}
        </Table>
      )}

      {viewing ? (
        <Submissions form={viewing} onClose={() => setViewing(null)} />
      ) : null}

      {building ? (
        <FormBuilder
          formId={building.id}
          fields={building.fields ?? []}
          tag={building.tag ?? null}
          style={building.style ?? null}
          onDone={() => setBuilding(null)}
        />
      ) : null}

      {showing ? (
        <EmbedCode form={showing} onClose={() => setShowing(null)} />
      ) : null}
    </div>
  );
}

/**
 * The snippet a customer pastes into their own site.
 *
 * The origin allow-list is the security boundary, not the snippet: a form only
 * accepts posts from the sites listed on it, so a copied snippet on someone
 * else's page is refused.
 */
function EmbedCode({ form, onClose }: { form: FormRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [origins, setOrigins] = useState(
    (form.allowedOrigins ?? []).join(", "),
  );
  // Plain HTML: the endpoint accepts a normal form post, so the snippet needs
  // no JavaScript and works on any site, including ones that block scripts.
  // The honeypot is hidden from people and irresistible to bots.
  const base = window.location.origin;
  // One tag. The previous snippet was a whole <form>, which meant every change
  // to a field was a change to their website — and every site drifted out of
  // step with the form it was showing.
  const snippet = `<script src="${base}/embed.js" data-sentrello-form="${form.key}"></script>`;

  const save = useMutation({
    mutationFn: () =>
      api(`/api/forms/${form.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          allowedOrigins: origins
            .split(",")
            .map((o) => o.trim())
            .filter(Boolean),
        }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["forms"] }),
  });

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <p className="font-medium">{form.name}</p>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>

      <Field
        label="Sites allowed to use this form"
        hint="Comma separated, e.g. https://example.com, https://*.example.com. Leave empty to allow only this site."
      >
        <Input value={origins} onChange={(e) => setOrigins(e.target.value)} />
      </Field>
      <div className="mt-2">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>

      <p className="mt-4 mb-1 text-sm font-medium">Paste this into your page</p>
      <pre
        className="overflow-x-auto rounded border p-3 text-xs"
        style={{ borderColor: "var(--border)" }}
      >
        <code>{snippet}</code>
      </pre>
      <Button
        variant="secondary"
        className="mt-2"
        onClick={() => navigator.clipboard?.writeText(snippet)}
      >
        Copy
      </Button>
      {save.error ? <ErrorNote error={save.error} /> : null}
    </Card>
  );
}

/**
 * What people sent, and what to do about it.
 *
 * A submission already made a contact on the way in. Deciding it is worth
 * pursuing is a judgement, so promoting it into the pipeline is a button — a
 * pipeline that fills itself with every newsletter sign-up stops being looked
 * at.
 */
function Submissions({
  form,
  onClose,
}: {
  form: FormRow;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["submissions", form.id],
    queryFn: () =>
      api<{
        submissions: {
          id: string;
          payload: Record<string, string>;
          createdAt: string;
          contactId: string | null;
        }[];
      }>(`/api/forms/${form.id}/submissions`),
  });

  const promote = useMutation({
    mutationFn: (id: string) =>
      api<{ already?: boolean }>(`/api/forms/submissions/${id}/promote`, {
        method: "POST",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deals"] });
      qc.invalidateQueries({ queryKey: ["submissions", form.id] });
    },
  });

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <p className="font-medium">{form.name} — submissions</p>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>

      {isLoading ? (
        <Loading />
      ) : data?.submissions.length ? (
        <ul className="space-y-2">
          {data.submissions.map((sub) => (
            <li
              key={sub.id}
              className="border-t pt-2 text-sm"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  {Object.entries(sub.payload).map(([k, v]) => (
                    <div key={k}>
                      <span className="text-xs" style={muted}>
                        {k}:{" "}
                      </span>
                      {v}
                    </div>
                  ))}
                  <div className="mt-0.5 text-xs" style={muted}>
                    {new Date(sub.createdAt).toLocaleString()}
                  </div>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => promote.mutate(sub.id)}
                  disabled={promote.isPending}
                >
                  Add to pipeline
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm" style={muted}>
          Nothing sent through this form yet.
        </p>
      )}
      {promote.error ? <ErrorNote error={promote.error} /> : null}
    </Card>
  );
}
