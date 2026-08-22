import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  muted,
} from "../lib/ui";

/**
 * Groups, and the rules a business sets for signing in.
 *
 * Keycloak's shape, in the words a small business uses. An administrator does
 * not want to think about permissions one person at a time: "the office" and
 * "the fitters" is how they already talk about themselves, and a new starter
 * joins a group rather than having six checkboxes copied from somebody who
 * looks similar.
 */

interface Group {
  id: string;
  name: string;
  description: string | null;
  roles: string[];
  members: { userId: string; name: string; email: string }[];
}

interface RoleInfo {
  role: string;
  builtIn: boolean;
  allows: Record<string, string[]>;
}

interface Device {
  id: string;
  device: string;
  ipAddress: string | null;
  updatedAt: string;
  current: boolean;
}

interface Policy {
  requireTwoFactorFor: string[];
  minPasswordLength: number;
  sessionDays: number | null;
}

export function Groups({
  people,
}: {
  people: { userId: string; name: string; email: string }[];
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const groups = useQuery({
    queryKey: ["user-groups"],
    queryFn: () => api<{ groups: Group[] }>("/api/users/groups"),
  });

  const roles = useQuery({
    queryKey: ["user-roles"],
    queryFn: () =>
      api<{ roles: RoleInfo[]; permissions: Record<string, string[]> }>(
        "/api/users/roles",
      ),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["user-groups"] });
    // The people list shows which groups somebody is in, and their effective
    // roles change with the group — so it is stale the moment this is.
    qc.invalidateQueries({ queryKey: ["users"] });
  };

  const create = useMutation({
    mutationFn: () =>
      api("/api/users/groups", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      setName("");
      refresh();
    },
  });

  const setRoles = useMutation({
    mutationFn: ({ id, next }: { id: string; next: string[] }) =>
      api(`/api/users/groups/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ roles: next }),
      }),
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/users/groups/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  const join = useMutation({
    mutationFn: ({ id, userId }: { id: string; userId: string }) =>
      api(`/api/users/groups/${id}/members`, {
        method: "POST",
        body: JSON.stringify({ userId }),
      }),
    onSuccess: refresh,
  });

  const leave = useMutation({
    mutationFn: ({ id, userId }: { id: string; userId: string }) =>
      api(`/api/users/groups/${id}/members/${userId}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  if (groups.isLoading || roles.isLoading) return <Loading />;
  if (groups.error) return <ErrorNote error={groups.error} />;
  const list = groups.data?.groups ?? [];
  const known = roles.data?.roles ?? [];

  return (
    <Card>
      <p className="font-medium">Groups</p>
      <p className="mt-1 text-sm" style={muted}>
        A group is a set of people who share a job. It carries roles, and
        everybody in it holds those roles as well as their own.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Field label="New group">
          <Input
            value={name}
            placeholder="The office"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) create.mutate();
            }}
          />
        </Field>
        <Button
          onClick={() => create.mutate()}
          disabled={create.isPending || !name.trim()}
        >
          Create
        </Button>
      </div>
      {create.error ? <ErrorNote error={create.error} /> : null}

      {list.length === 0 ? (
        <div className="mt-4">
          <Empty title="No groups yet">
            Until there are groups, everybody's permissions come from their own
            role alone — which is fine for three people and tiring for twelve.
          </Empty>
        </div>
      ) : (
        <ul className="mt-4 space-y-3">
          {list.map((group) => (
            <li key={group.id} className="rounded border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <button
                  type="button"
                  className="font-medium underline-offset-2 hover:underline"
                  onClick={() => setOpen(open === group.id ? null : group.id)}
                >
                  {group.name}
                </button>
                <span className="text-xs" style={muted}>
                  {group.members.length}{" "}
                  {group.members.length === 1 ? "person" : "people"}
                  {group.roles.length > 0 ? ` · ${group.roles.join(", ")}` : ""}
                </span>
              </div>

              {open === group.id ? (
                <div className="mt-3 space-y-3">
                  <div>
                    <p className="text-sm" style={muted}>
                      What this group grants
                    </p>
                    <div className="mt-1 flex flex-wrap gap-3 text-sm">
                      {known.map((role) => (
                        <label
                          key={role.role}
                          className="flex items-center gap-1.5"
                        >
                          <input
                            type="checkbox"
                            checked={group.roles.includes(role.role)}
                            onChange={(e) =>
                              setRoles.mutate({
                                id: group.id,
                                next: e.target.checked
                                  ? [...group.roles, role.role]
                                  : group.roles.filter((r) => r !== role.role),
                              })
                            }
                          />
                          {role.role}
                        </label>
                      ))}
                    </div>
                  </div>

                  <div>
                    <p className="text-sm" style={muted}>
                      Who is in it
                    </p>
                    <div className="mt-1 space-y-1 text-sm">
                      {people.map((person) => {
                        const inside = group.members.some(
                          (m) => m.userId === person.userId,
                        );
                        return (
                          <label
                            key={person.userId}
                            className="flex items-center gap-1.5"
                          >
                            <input
                              type="checkbox"
                              checked={inside}
                              disabled={join.isPending || leave.isPending}
                              onChange={() =>
                                inside
                                  ? leave.mutate({
                                      id: group.id,
                                      userId: person.userId,
                                    })
                                  : join.mutate({
                                      id: group.id,
                                      userId: person.userId,
                                    })
                              }
                            />
                            {person.name || person.email}
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  <Button
                    variant="secondary"
                    onClick={() => remove.mutate(group.id)}
                    disabled={remove.isPending}
                  >
                    Delete group
                  </Button>
                  <p className="text-xs" style={muted}>
                    Deleting it leaves everybody with their own role and takes
                    the group's away.
                  </p>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {setRoles.error ? <ErrorNote error={setRoles.error} /> : null}
      {join.error ? <ErrorNote error={join.error} /> : null}
    </Card>
  );
}

/** The rules for getting in: who needs a second factor, and how long a session lasts. */
export function SignInRules() {
  const qc = useQueryClient();

  const policy = useQuery({
    queryKey: ["user-policy"],
    queryFn: () => api<{ policy: Policy }>("/api/users/policy"),
  });
  const roles = useQuery({
    queryKey: ["user-roles"],
    queryFn: () => api<{ roles: RoleInfo[] }>("/api/users/roles"),
  });

  const save = useMutation({
    mutationFn: (next: Partial<Policy>) =>
      api("/api/users/policy", {
        method: "PUT",
        body: JSON.stringify(next),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["user-policy"] });
      qc.invalidateQueries({ queryKey: ["users"] });
    },
  });

  if (policy.isLoading || roles.isLoading) return <Loading />;
  if (policy.error) return <ErrorNote error={policy.error} />;
  const current = policy.data?.policy;
  if (!current) return null;

  return (
    <Card>
      <p className="font-medium">Signing in</p>
      <p className="mt-1 text-sm" style={muted}>
        Who has to use a second factor, and how long somebody stays signed in.
      </p>

      <div className="mt-3">
        <p className="text-sm" style={muted}>
          Require two-factor for
        </p>
        <div className="mt-1 flex flex-wrap gap-3 text-sm">
          {(roles.data?.roles ?? []).map((role) => (
            <label key={role.role} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={current.requireTwoFactorFor.includes(role.role)}
                onChange={(e) =>
                  save.mutate({
                    requireTwoFactorFor: e.target.checked
                      ? [...current.requireTwoFactorFor, role.role]
                      : current.requireTwoFactorFor.filter(
                          (r) => r !== role.role,
                        ),
                  })
                }
              />
              {role.role}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs" style={muted}>
          The person who can move money is not the person who clocks in on a
          shared tablet, so this is per role rather than for everybody.
        </p>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Shortest password" hint="Between 8 and 72 characters.">
          <Input
            type="number"
            defaultValue={current.minPasswordLength}
            onBlur={(e) =>
              save.mutate({ minPasswordLength: Number(e.target.value) })
            }
          />
        </Field>
        <Field
          label="Stay signed in for"
          hint="Days. Leave blank to use the platform's own timing."
        >
          <Input
            type="number"
            defaultValue={current.sessionDays ?? ""}
            onBlur={(e) =>
              save.mutate({
                sessionDays: e.target.value ? Number(e.target.value) : null,
              })
            }
          />
        </Field>
      </div>
      {save.error ? <ErrorNote error={save.error} /> : null}
    </Card>
  );
}

/** Where somebody is signed in, and a way to end it. */
export function Devices({
  userId,
  own,
}: {
  /** Whose devices. Omitted means the person doing the looking. */
  userId?: string;
  own?: boolean;
}) {
  const qc = useQueryClient();
  const path = own ? "/api/users/me/sessions" : `/api/users/${userId}/sessions`;

  const list = useQuery({
    queryKey: ["user-sessions", userId ?? "me"],
    queryFn: () => api<{ sessions: Device[] }>(path),
  });

  const end = useMutation({
    mutationFn: (id: string) => api(`${path}/${id}`, { method: "DELETE" }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["user-sessions", userId ?? "me"] }),
  });

  if (list.isLoading) return <Loading />;
  if (list.error) return <ErrorNote error={list.error} />;
  const sessions = list.data?.sessions ?? [];

  return (
    <div className="space-y-2">
      {sessions.length === 0 ? (
        <p className="text-sm" style={muted}>
          Nothing is signed in.
        </p>
      ) : (
        sessions.map((session) => (
          <div
            key={session.id}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span>
              {session.device}
              {session.current ? (
                <span style={muted}> · this device</span>
              ) : null}
              {session.ipAddress ? (
                <span style={muted}> · {session.ipAddress}</span>
              ) : null}
            </span>
            <Button
              variant="secondary"
              onClick={() => end.mutate(session.id)}
              disabled={end.isPending || session.current}
            >
              Sign out
            </Button>
          </div>
        ))
      )}
      {end.error ? <ErrorNote error={end.error} /> : null}
    </div>
  );
}
