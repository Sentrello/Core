import { statement } from "@sentrello/auth/permissions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Member, type OrgRole, memberApi, roleApi } from "../lib/auth";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Loading,
  Row,
  Select,
  Table,
  muted,
} from "../lib/ui";

/**
 * Who may do what.
 *
 * The five shipped roles cover a handyman with three staff. They do not cover
 * a workshop manager who sees jobs and stock but not the books, and the
 * previous answer to that was "use Staff and hope" — which grants more than
 * intended rather than less.
 *
 * The matrix is generated from the same statement the server enforces, so a
 * module added tomorrow appears here without anybody remembering to add it. A
 * hand-written list would drift, and the drift would be silent: a resource
 * nobody can grant is a feature nobody can use.
 */

/** Better Auth's own resources. A business manages people, not invitations. */
const HIDDEN = new Set(["organization", "member", "invitation", "ac", "team"]);

const RESOURCES = Object.entries(statement)
  .filter(([name]) => !HIDDEN.has(name))
  .map(([name, actions]) => ({
    name,
    actions: [...(actions as readonly string[])],
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

function Matrix({
  value,
  onChange,
}: {
  value: Record<string, string[]>;
  onChange: (next: Record<string, string[]>) => void;
}) {
  const toggle = (resource: string, action: string, on: boolean) => {
    const current = new Set(value[resource] ?? []);
    if (on) current.add(action);
    else current.delete(action);
    const next = { ...value };
    if (current.size) next[resource] = [...current];
    else delete next[resource];
    onChange(next);
  };

  return (
    <div className="space-y-1">
      {RESOURCES.map((r) => (
        <div key={r.name} className="flex flex-wrap items-center gap-2">
          <span className="w-32 shrink-0 text-sm">{r.name}</span>
          {r.actions.map((a) => (
            <label key={a} className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={(value[r.name] ?? []).includes(a)}
                onChange={(e) => toggle(r.name, a, e.target.checked)}
              />
              {a}
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Giving a role to somebody.
 *
 * Without this the whole feature is decorative: a business can define a
 * workshop manager and has no way to make anyone one. The built-in roles are
 * offered alongside the custom ones, because moving somebody from Staff to
 * Accounting is the same act as moving them to a role you invented.
 */
function People({ custom }: { custom: OrgRole[] }) {
  const qc = useQueryClient();
  const members = useQuery({
    queryKey: ["org-members"],
    queryFn: async () => (await memberApi.listMembers()).data?.members ?? [],
  });

  const assign = useMutation({
    mutationFn: async ({
      memberId,
      role,
    }: { memberId: string; role: string }) => {
      const res = await memberApi.updateMemberRole({ memberId, role });
      if (res.error) throw new Error(res.error.message ?? "Could not change");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["org-members"] }),
  });

  const choices = [
    "owner",
    "admin",
    "staff",
    "accounting",
    "customer",
    ...custom.map((r) => r.role),
  ];

  if (members.isLoading) return <Loading />;

  return (
    <Card>
      <p className="mb-2 font-medium">People</p>
      {members.data?.length ? (
        <Table headers={["Name", "Email", "Role"]}>
          {members.data.map((m: Member) => (
            <Row key={m.id}>
              <td className="py-2">{m.user.name || "—"}</td>
              <td style={muted}>{m.user.email}</td>
              <td>
                <Select
                  value={m.role}
                  aria-label={`Role for ${m.user.email}`}
                  onChange={(e) =>
                    assign.mutate({ memberId: m.id, role: e.target.value })
                  }
                >
                  {/* A role the member already holds but which no longer
                      exists still shows, or the dropdown would silently
                      reassign them on the next change. */}
                  {(choices.includes(m.role)
                    ? choices
                    : [m.role, ...choices]
                  ).map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </td>
            </Row>
          ))}
        </Table>
      ) : (
        <p className="text-sm" style={muted}>
          Nobody else has been invited yet.
        </p>
      )}
      {assign.error ? <ErrorNote error={assign.error} /> : null}
    </Card>
  );
}

export function Roles() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [permission, setPermission] = useState<Record<string, string[]>>({
    // Every role needs the landing page, or its holder signs in to nothing.
    dashboard: ["read"],
  });
  const [creating, setCreating] = useState(false);

  const custom = useQuery({
    queryKey: ["org-roles"],
    queryFn: async () => {
      const res = await roleApi.listRoles();
      return res.data ?? [];
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const res = await roleApi.createRole({
        role: name.trim(),
        permission,
      });
      if (res.error) throw new Error(res.error.message ?? "Could not create");
    },
    onSuccess: () => {
      setName("");
      setPermission({ dashboard: ["read"] });
      setCreating(false);
      qc.invalidateQueries({ queryKey: ["org-roles"] });
    },
  });

  const remove = useMutation({
    mutationFn: async (roleName: string) => {
      const res = await roleApi.deleteRole({ roleName });
      if (res.error) throw new Error(res.error.message ?? "Could not delete");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["org-roles"] }),
  });

  if (custom.isLoading) return <Loading />;

  return (
    <div className="space-y-4">
      <People custom={custom.data ?? []} />

      <Card>
        <p className="font-medium">Roles that come with Sentrello</p>
        <p className="mt-1 text-sm" style={muted}>
          These cannot be deleted. To give somebody something different, make a
          role below.
        </p>
        <ul className="mt-2 space-y-1 text-sm">
          <li>
            <strong>Owner</strong>
            <span style={muted}>
              {" "}
              — everything, including billing and setup
            </span>
          </li>
          <li>
            <strong>Admin</strong>
            <span style={muted}> — everything except owning the instance</span>
          </li>
          <li>
            <strong>Staff</strong>
            <span style={muted}> — the work, not the books</span>
          </li>
          <li>
            <strong>Accounting</strong>
            <span style={muted}> — the books, not the work</span>
          </li>
          <li>
            <strong>Customer</strong>
            <span style={muted}> — their own records only</span>
          </li>
        </ul>
      </Card>

      <div className="flex items-center justify-between">
        <p className="font-medium">Your own roles</p>
        <Button onClick={() => setCreating((v) => !v)}>
          {creating ? "Cancel" : "New role"}
        </Button>
      </div>

      {creating ? (
        <Card>
          <Field label="Name" hint="What this job is called in your business.">
            <Input
              value={name}
              placeholder="Workshop manager"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>

          <p className="mt-3 mb-1 text-sm font-medium">What they may do</p>
          <p className="mb-2 text-xs" style={muted}>
            {/* Better Auth enforces this; saying it up front beats a refusal
                somebody has to interpret. */}
            You can only grant what you hold yourself.
          </p>
          <Matrix value={permission} onChange={setPermission} />

          <div className="mt-3">
            <Button
              onClick={() => create.mutate()}
              disabled={!name.trim() || create.isPending}
            >
              {create.isPending ? "Creating…" : "Create role"}
            </Button>
          </div>
          {create.error ? <ErrorNote error={create.error} /> : null}
        </Card>
      ) : null}

      {custom.data?.length ? (
        <Table headers={["Role", "May do", ""]}>
          {custom.data.map((r) => {
            let granted: Record<string, string[]> = {};
            try {
              granted = JSON.parse(r.permission);
            } catch {
              // A row we cannot read is still a row somebody can delete, so
              // it is shown rather than hidden.
            }
            return (
              <Row key={r.id}>
                <td className="py-2 font-medium">{r.role}</td>
                <td style={muted}>
                  {Object.entries(granted)
                    .map(([res, actions]) => `${res} (${actions.join(", ")})`)
                    .join(" · ") || "nothing"}
                </td>
                <td className="text-right">
                  <button
                    type="button"
                    className="text-sm underline"
                    style={{ color: "var(--color-danger)" }}
                    onClick={() => remove.mutate(r.role)}
                  >
                    Delete
                  </button>
                </td>
              </Row>
            );
          })}
        </Table>
      ) : (
        <Card>
          <p className="text-sm" style={muted}>
            No roles of your own yet. The five above cover most businesses; make
            one when they do not.
          </p>
        </Card>
      )}
      {remove.error ? <ErrorNote error={remove.error} /> : null}
    </div>
  );
}
