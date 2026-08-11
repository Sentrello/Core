import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Contact, api } from "../lib/api";
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

export function Contacts() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["contacts"],
    queryFn: () => api<{ contacts: Contact[] }>("/api/contacts"),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;

  const term = search.trim().toLowerCase();
  const contacts = (data?.contacts ?? []).filter((c) =>
    term
      ? `${c.name} ${c.email ?? ""} ${c.phone ?? ""}`
          .toLowerCase()
          .includes(term)
      : true,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Input
          placeholder="Search contacts"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <div className="ml-auto">
          <Button onClick={() => setAdding((v) => !v)}>
            {adding ? "Cancel" : "Add contact"}
          </Button>
        </div>
      </div>

      {adding ? (
        <NewContact
          onDone={() => {
            setAdding(false);
            qc.invalidateQueries({ queryKey: ["contacts"] });
          }}
        />
      ) : null}

      {contacts.length === 0 ? (
        <Empty title={term ? "No matches" : "No contacts yet"}>
          {term
            ? "Try a different search."
            : "People who fill in your forms or book with you land here automatically."}
        </Empty>
      ) : (
        <Table headers={["Name", "Email", "Phone", "Type"]}>
          {contacts.map((c) => (
            <Row key={c.id}>
              <td className="py-2 font-medium">{c.name}</td>
              <td>{c.email ?? "—"}</td>
              <td>{c.phone ?? "—"}</td>
              <td style={muted}>{c.kind}</td>
            </Row>
          ))}
        </Table>
      )}
    </div>
  );
}

function NewContact({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [kind, setKind] = useState("person");

  const create = useMutation({
    mutationFn: () =>
      api("/api/contacts", {
        method: "POST",
        body: JSON.stringify({
          name,
          email: email || null,
          phone: phone || null,
          kind,
        }),
      }),
    onSuccess: onDone,
  });

  return (
    <Card>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_8rem_auto]">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Phone">
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Type">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="person">Person</option>
            <option value="company">Company</option>
          </Select>
        </Field>
        <div className="flex items-end">
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending || !name.trim()}
          >
            {create.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      {create.error ? <ErrorNote error={create.error} /> : null}
    </Card>
  );
}
