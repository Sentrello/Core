import { useQuery } from "@tanstack/react-query";
import { type Contact, api } from "../lib/api";

export function Contacts() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["contacts"],
    queryFn: () => api<{ contacts: Contact[] }>("/api/contacts"),
  });

  if (isLoading) return <p className="text-sm">Loading…</p>;
  if (error) {
    return (
      <p className="text-sm" style={{ color: "var(--color-danger)" }}>
        Could not load contacts.
      </p>
    );
  }

  const contacts = data?.contacts ?? [];
  if (contacts.length === 0) {
    return (
      <div className="rounded border p-8 text-center" style={borderStyle}>
        <p className="font-medium">No contacts yet</p>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Contacts you add will appear here.
        </p>
      </div>
    );
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left" style={borderStyle}>
          <th className="py-2">Name</th>
          <th>Email</th>
          <th>Phone</th>
          <th>Type</th>
        </tr>
      </thead>
      <tbody>
        {contacts.map((c) => (
          <tr key={c.id} className="border-b" style={borderStyle}>
            <td className="py-2">{c.name}</td>
            <td>{c.email ?? "—"}</td>
            <td>{c.phone ?? "—"}</td>
            <td>{c.kind}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const borderStyle = { borderColor: "var(--border)" };
