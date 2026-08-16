import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Contact, api } from "../lib/api";
import { useNavigation } from "../lib/navigation";
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
import { ContactsImport } from "./contacts-import";

export function Contacts() {
  const qc = useQueryClient();
  const { open } = useNavigation();
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
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
        <div className="ml-auto flex items-center gap-2">
          {/* A plain link, not a fetch: the browser downloads it with the
              filename the server sends, and the session cookie goes along. */}
          <a
            href="/api/contacts/export.csv"
            className="text-sm underline"
            style={muted}
          >
            Export
          </a>
          <button
            type="button"
            className="text-sm underline"
            style={muted}
            onClick={() => setImporting((v) => !v)}
          >
            Import
          </button>
          <Button onClick={() => setAdding((v) => !v)}>
            {adding ? "Cancel" : "Add contact"}
          </Button>
        </div>
      </div>

      {importing ? <ContactsImport onDone={() => setImporting(false)} /> : null}

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
        <Table headers={["Name", "Email", "Phone", "Type", ""]}>
          {contacts.map((c) =>
            editing === c.id ? (
              <Row key={c.id}>
                <td colSpan={5} className="py-2">
                  <EditContact
                    contact={c}
                    onDone={() => {
                      setEditing(null);
                      qc.invalidateQueries({ queryKey: ["contacts"] });
                    }}
                  />
                </td>
              </Row>
            ) : (
              <Row key={c.id}>
                <td className="py-2 font-medium">
                  {/* Opens the contact rather than an edit form. Editing a row
                      in place was fine when a contact was four fields; now
                      there is a company, deals, notes and follow-ups to see,
                      and the name is the way in to all of it. */}
                  <button
                    type="button"
                    className="underline-offset-2 hover:underline"
                    onClick={() =>
                      open({ moduleId: "crm", recordId: c.id, title: c.name })
                    }
                  >
                    {c.name}
                  </button>
                </td>
                <td>{c.email ?? "—"}</td>
                <td>{c.phone ?? "—"}</td>
                <td style={muted}>{c.kind}</td>
                <td className="text-right">
                  <PortalLink contact={c} />
                </td>
              </Row>
            ),
          )}
        </Table>
      )}
    </div>
  );
}

/**
 * Editing a customer in place.
 *
 * Deleting is here rather than on the row because it belongs next to the
 * details you are looking at while deciding — and because the server refuses
 * to delete a customer with invoices, this has to be able to show that reason
 * rather than a generic failure.
 */
function EditContact({
  contact,
  onDone,
}: {
  contact: Contact;
  onDone: () => void;
}) {
  const [name, setName] = useState(contact.name);
  const [email, setEmail] = useState(contact.email ?? "");
  const [phone, setPhone] = useState(contact.phone ?? "");
  const [confirming, setConfirming] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      api(`/api/contacts/${contact.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name,
          email: email || null,
          phone: phone || null,
        }),
      }),
    onSuccess: onDone,
  });

  const remove = useMutation({
    mutationFn: () => api(`/api/contacts/${contact.id}`, { method: "DELETE" }),
    onSuccess: onDone,
  });

  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto_auto]">
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
        <div className="flex items-end gap-2">
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || !name.trim()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
        </div>
        <div className="flex items-end">
          {confirming ? (
            <Button
              variant="danger"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              {remove.isPending ? "Deleting…" : "Really delete"}
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => setConfirming(true)}>
              Delete
            </Button>
          )}
        </div>
      </div>
      {save.error ? <ErrorNote error={save.error} /> : null}
      {remove.error ? <ErrorNote error={remove.error} /> : null}
    </div>
  );
}

/**
 * The link a customer follows to see what they owe.
 *
 * Sending it is the default action, because a link the business has to copy
 * out of a dialog and paste into their own email client is a link that stays
 * in the dialog. Copying is there for the times email is not the channel.
 */
function PortalLink({ contact }: { contact: Contact }) {
  const [url, setUrl] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const mint = useMutation({
    mutationFn: (send: boolean) =>
      api<{ url: string; sent?: boolean }>(
        `/api/contacts/${contact.id}/portal-link${send ? "?send=1" : ""}`,
        { method: "POST" },
      ),
    onSuccess: (data, send) => {
      setUrl(data.url);
      setSent(send && data.sent === true);
    },
  });

  return (
    <div className="text-right">
      <div className="flex justify-end gap-2">
        <Button
          variant="secondary"
          onClick={() => mint.mutate(false)}
          disabled={mint.isPending}
        >
          {url ? "Copy link" : "Portal link"}
        </Button>
        {contact.email ? (
          <Button onClick={() => mint.mutate(true)} disabled={mint.isPending}>
            {sent ? "Sent" : "Email it"}
          </Button>
        ) : null}
      </div>
      {url ? (
        <button
          type="button"
          className="mt-1 block w-full truncate text-right text-xs underline"
          style={muted}
          onClick={() => navigator.clipboard?.writeText(url)}
          title={url}
        >
          {url}
        </button>
      ) : null}
      {mint.error ? <ErrorNote error={mint.error} /> : null}
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
