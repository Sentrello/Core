import { statement } from "@sentrello/auth/permissions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { type OrgRole, memberApi, roleApi } from "../lib/auth";
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
  formatDate,
  muted,
} from "../lib/ui";

/**
 * Who is on this instance, and what each of them may do.
 *
 * Identity and access in one place: the people, their roles, the way back in
 * when somebody is locked out, and the roles a business writes for itself.
 * Previously this screen could only edit roles, so an administrator whose
 * bookkeeper had left — or whose foreman had lost the phone with his
 * authenticator on it — was sent to a terminal. The administrator here is
 * usually the owner of the business, and that was never going to happen.
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

interface Person {
  userId: string;
  memberId: string;
  name: string;
  email: string;
  role: string;
  twoFactorEnabled: boolean;
  lastSeenAt: string | null;
  you: boolean;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
}

interface Change {
  at: string;
  actor: string;
  subject: string | null;
  says: string;
  detail: Record<string, unknown> | null;
}

/**
 * The people, and everything an administrator has to be able to do to them.
 *
 * Each destructive action asks first, and says what it will do rather than
 * "are you sure" — somebody removing a person at half past four should not
 * have to guess whether their invoices go with them.
 */
function People({ custom }: { custom: OrgRole[] }) {
  const qc = useQueryClient();
  const [invitee, setInvitee] = useState("");
  const [inviteRole, setInviteRole] = useState("staff");
  const [issued, setIssued] = useState<{
    email: string;
    password: string;
  } | null>(null);

  const data = useQuery({
    queryKey: ["users"],
    queryFn: () =>
      api<{
        people: Person[];
        invitations: Invitation[];
        history: Change[];
      }>("/api/users"),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["users"] });
  const roleNames = [
    "admin",
    "accounting",
    "staff",
    ...custom.map((r) => r.role),
  ];

  const setRole = useMutation({
    mutationFn: (input: { userId: string; role: string }) =>
      api(`/api/users/${input.userId}/role`, {
        method: "POST",
        body: JSON.stringify({ role: input.role }),
      }),
    onSuccess: refresh,
  });

  const invite = useMutation({
    mutationFn: async () => {
      const res = await memberApi.inviteMember({
        email: invitee.trim(),
        role: inviteRole,
      });
      if (res.error) throw new Error(res.error.message ?? "Could not invite");
    },
    onSuccess: () => {
      setInvitee("");
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (userId: string) =>
      api(`/api/users/${userId}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  const resetPassword = useMutation({
    mutationFn: (person: Person) =>
      api<{ password: string }>(`/api/users/${person.userId}/password`, {
        method: "POST",
      }).then((r) => ({ email: person.email, password: r.password })),
    onSuccess: (result) => {
      // Shown once, here, because it is never stored anywhere it could be
      // read again — and because the administrator is usually standing next
      // to the person who is locked out.
      setIssued(result);
      refresh();
    },
  });

  const revokeTwoFactor = useMutation({
    mutationFn: (userId: string) =>
      api(`/api/users/${userId}/two-factor/revoke`, { method: "POST" }),
    onSuccess: refresh,
  });

  const signOut = useMutation({
    mutationFn: (userId: string) =>
      api(`/api/users/${userId}/sessions/revoke`, { method: "POST" }),
    onSuccess: refresh,
  });

  if (data.isLoading) return <Loading />;
  if (data.error) return <ErrorNote error={data.error} />;

  const people = data.data?.people ?? [];
  const invitations = data.data?.invitations ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <p className="mb-2 font-medium">Invite somebody</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Email">
            <Input
              type="email"
              value={invitee}
              placeholder="sam@yourbusiness.com"
              onChange={(e) => setInvitee(e.target.value)}
            />
          </Field>
          <Field label="Role">
            <Select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
            >
              {roleNames.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            onClick={() => invite.mutate()}
            disabled={invite.isPending || !invitee.trim()}
          >
            {invite.isPending ? "Inviting…" : "Send invitation"}
          </Button>
        </div>
        {invite.error ? <ErrorNote error={invite.error} /> : null}
        {invitations.length > 0 ? (
          <p className="mt-2 text-sm" style={muted}>
            Waiting to be accepted: {invitations.map((i) => i.email).join(", ")}
          </p>
        ) : null}
      </Card>

      {issued ? (
        <Card>
          <p className="font-medium">New password for {issued.email}</p>
          <p className="money mt-1 text-lg tracking-wide">{issued.password}</p>
          <p className="mt-1 text-sm" style={muted}>
            Shown once and stored nowhere. Read it to them, and have them change
            it. They have been signed out everywhere.
          </p>
          <div className="mt-2">
            <Button variant="secondary" onClick={() => setIssued(null)}>
              Done
            </Button>
          </div>
        </Card>
      ) : null}

      <Table headers={["Name", "Email", "Role", "Two-factor", "Last seen", ""]}>
        {people.map((p) => (
          <Row key={p.userId}>
            <td className="py-2 font-medium">
              {p.name || "—"}
              {p.you ? (
                <span className="ml-2 text-xs" style={muted}>
                  you
                </span>
              ) : null}
            </td>
            <td style={muted}>{p.email}</td>
            <td>
              {p.you ? (
                // Changing your own role is how an owner locks the business
                // out of its own instance, and nobody else can undo it.
                <span style={muted}>{p.role}</span>
              ) : (
                <Select
                  value={p.role}
                  onChange={(e) =>
                    setRole.mutate({ userId: p.userId, role: e.target.value })
                  }
                >
                  {[...new Set([p.role, ...roleNames])].map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              )}
            </td>
            <td>
              {p.twoFactorEnabled ? (
                <button
                  type="button"
                  className="text-xs underline"
                  style={muted}
                  onClick={() =>
                    confirm(
                      `Turn off two-factor for ${p.email}? They will be signed out everywhere and can set it up again.`,
                    ) && revokeTwoFactor.mutate(p.userId)
                  }
                >
                  on — turn off
                </button>
              ) : (
                <span style={muted}>off</span>
              )}
            </td>
            <td style={muted}>
              {p.lastSeenAt ? formatDate(p.lastSeenAt) : "never"}
            </td>
            <td className="space-x-3 text-right">
              <button
                type="button"
                className="text-xs underline"
                style={muted}
                onClick={() =>
                  confirm(
                    `Give ${p.email} a new password? Theirs stops working immediately and they are signed out everywhere.`,
                  ) && resetPassword.mutate(p)
                }
              >
                Reset password
              </button>
              {p.you ? null : (
                <>
                  <button
                    type="button"
                    className="text-xs underline"
                    style={muted}
                    onClick={() => signOut.mutate(p.userId)}
                  >
                    Sign out
                  </button>
                  <button
                    type="button"
                    className="text-xs"
                    style={{ color: "var(--color-danger)" }}
                    onClick={() =>
                      confirm(
                        `Remove ${p.email}? They lose access immediately. Their invoices, notes and history stay.`,
                      ) && remove.mutate(p.userId)
                    }
                  >
                    Remove
                  </button>
                </>
              )}
            </td>
          </Row>
        ))}
      </Table>

      {(data.data?.history ?? []).length > 0 ? (
        <Card>
          <p className="font-medium">Recent changes</p>
          <p className="mt-1 text-xs" style={muted}>
            Everything on this screen hands access around, so it is written
            down. Nothing here can be edited or deleted.
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {(data.data?.history ?? []).map((change) => (
              <li key={`${change.at}-${change.says}-${change.subject ?? ""}`}>
                <span style={muted}>{formatDate(change.at)}</span>{" "}
                <strong>{change.actor}</strong> {change.says}{" "}
                <strong>{change.subject ?? "—"}</strong>
                {change.detail && "from" in change.detail ? (
                  <span style={muted}>
                    {" "}
                    ({String(change.detail.from)} → {String(change.detail.to)})
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {[setRole, remove, resetPassword, revokeTwoFactor, signOut].map((m, i) =>
        m.error ? <ErrorNote key={String(i)} error={m.error} /> : null,
      )}
    </div>
  );
}

export function Users() {
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
