import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { useTheme } from "../lib/theme";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Loading,
  Select,
  formatDate,
  muted,
} from "../lib/ui";

/**
 * Your own account, as opposed to the business's settings.
 *
 * Two screens rather than one section of Settings, because the questions are
 * different: Settings is what the business is called and how it invoices, this
 * is how the application behaves for you and who is signed in as you. Someone
 * with no permission to change the former still has to be able to change the
 * latter.
 */

export interface Profile {
  user: { name: string; email: string };
  preferences: {
    timezone: string;
    dateFormat: "ISO" | "DMY" | "MDY";
    currency: string;
    landingPage: string;
    workingHours: { start: string; end: string; days: number[] };
  };
  sessions: {
    id: string;
    current: boolean;
    signedInAt: string;
    lastSeenAt: string;
    ipAddress: string | null;
    userAgent: string | null;
  }[];
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * "Chrome on macOS" out of a user-agent string.
 *
 * Deliberately rough. The question this answers is "is that laptop me?", and a
 * browser and an operating system is enough to answer it — a full parser would
 * be a dependency, and the string is a lie often enough that precision here
 * would be false confidence.
 */
function device(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : /Firefox\//.test(userAgent)
            ? "Firefox"
            : "Browser";
  const os = /iPhone|iPad/.test(userAgent)
    ? "iOS"
    : /Android/.test(userAgent)
      ? "Android"
      : /Mac OS X/.test(userAgent)
        ? "macOS"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

export function ProfileScreen() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["profile"],
    queryFn: () => api<Profile>("/api/profile"),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <Details profile={data} onSaved={() => qc.invalidateQueries()} />
      <Password />
      <Sessions
        sessions={data.sessions}
        onRevoked={() => qc.invalidateQueries({ queryKey: ["profile"] })}
      />
    </div>
  );
}

function Details({
  profile,
  onSaved,
}: {
  profile: Profile;
  onSaved: () => void;
}) {
  const [name, setName] = useState(profile.user.name);
  const [prefs, setPrefs] = useState(profile.preferences);
  const [theme, setTheme] = useTheme();

  const save = useMutation({
    mutationFn: () =>
      api<{ preferences: Profile["preferences"] }>("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({ name, preferences: prefs }),
      }),
    // Everything, not just the profile: dates and money on every open screen
    // are formatted from these, and a currency that changes on the next reload
    // rather than on save looks like the save did not work.
    onSuccess: () => onSaved(),
  });

  const set = <K extends keyof Profile["preferences"]>(
    key: K,
    value: Profile["preferences"][K],
  ) => setPrefs((p) => ({ ...p, [key]: value }));

  const toggleDay = (day: number) =>
    set("workingHours", {
      ...prefs.workingHours,
      days: prefs.workingHours.days.includes(day)
        ? prefs.workingHours.days.filter((d) => d !== day)
        : [...prefs.workingHours.days, day].sort((a, b) => a - b),
    });

  return (
    <Card>
      <p className="mb-2 font-medium">You</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email" hint="Changing this is not supported yet.">
          <Input value={profile.user.email} readOnly />
        </Field>
      </div>

      <p className="mt-4 mb-2 font-medium">How the application behaves</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Timezone" hint="Blank follows this computer.">
          <Input
            value={prefs.timezone}
            placeholder={
              Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC"
            }
            onChange={(e) => set("timezone", e.target.value)}
          />
        </Field>
        <Field label="Date format">
          <Select
            value={prefs.dateFormat}
            onChange={(e) =>
              set(
                "dateFormat",
                e.target.value as Profile["preferences"]["dateFormat"],
              )
            }
          >
            <option value="MDY">Month first (Aug 9, 2026)</option>
            <option value="DMY">Day first (9 Aug 2026)</option>
            <option value="ISO">Year first (2026-08-09)</option>
          </Select>
        </Field>
        <Field label="Currency" hint="How money is shown to you.">
          <Input
            value={prefs.currency}
            maxLength={3}
            onChange={(e) => set("currency", e.target.value.toUpperCase())}
          />
        </Field>
        <Field label="Open on" hint="Which screen signing in lands on.">
          <Input
            value={prefs.landingPage}
            placeholder="dashboard"
            onChange={(e) => set("landingPage", e.target.value)}
          />
        </Field>
      </div>

      <p className="mt-4 mb-2 font-medium">Working hours</p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="From">
          <Input
            type="time"
            value={prefs.workingHours.start}
            onChange={(e) =>
              set("workingHours", {
                ...prefs.workingHours,
                start: e.target.value,
              })
            }
          />
        </Field>
        <Field label="To">
          <Input
            type="time"
            value={prefs.workingHours.end}
            onChange={(e) =>
              set("workingHours", {
                ...prefs.workingHours,
                end: e.target.value,
              })
            }
          />
        </Field>
        <div className="flex flex-wrap gap-2 pb-1 text-sm">
          {DAYS.map((label, day) => (
            <label key={label} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={prefs.workingHours.days.includes(day)}
                onChange={() => toggleDay(day)}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <p className="mt-4 mb-2 font-medium">Appearance</p>
      <div className="flex gap-2 text-sm">
        {(["light", "dark", "system"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTheme(t)}
            aria-pressed={theme === t}
            className="rounded px-3 py-1 capitalize"
            style={
              theme === t
                ? {
                    background: "var(--color-brand-500)",
                    color: "var(--color-neutral-50)",
                  }
                : muted
            }
          >
            {t}
          </button>
        ))}
      </div>
      {/* Kept on this machine rather than on the account: it has to be applied
          before the page paints, and a value that needs a request first means
          a white flash on every load for anybody using dark. */}
      <p className="mt-1 text-xs" style={muted}>
        Appearance is remembered on this device.
      </p>

      <div className="mt-4">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
      {save.error ? <ErrorNote error={save.error} /> : null}
    </Card>
  );
}

function Password() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [done, setDone] = useState(false);

  const change = useMutation({
    mutationFn: () =>
      api("/api/profile/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setDone(true);
    },
  });

  return (
    <Card>
      <p className="mb-2 font-medium">Password</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Current password">
          <Input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => {
              setDone(false);
              setCurrent(e.target.value);
            }}
          />
        </Field>
        <Field label="New password">
          <Input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => {
              setDone(false);
              setNext(e.target.value);
            }}
          />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button
          onClick={() => change.mutate()}
          disabled={change.isPending || !current || !next}
        >
          {change.isPending ? "Changing…" : "Change password"}
        </Button>
        {done ? (
          <span className="text-sm" style={muted}>
            Changed. Your other devices stay signed in.
          </span>
        ) : null}
      </div>
      {change.error ? <ErrorNote error={change.error} /> : null}
    </Card>
  );
}

function Sessions({
  sessions,
  onRevoked,
}: {
  sessions: Profile["sessions"];
  onRevoked: () => void;
}) {
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`/api/profile/sessions/${id}`, { method: "DELETE" }),
    onSuccess: onRevoked,
  });

  return (
    <Card>
      <p className="mb-2 font-medium">Where you are signed in</p>
      <ul className="space-y-2">
        {sessions.map((s) => (
          <li
            key={s.id}
            className="flex flex-wrap items-baseline justify-between gap-2 border-t pt-2 text-sm"
            style={{ borderColor: "var(--border)" }}
          >
            <div>
              <div>
                {device(s.userAgent)}
                {s.current ? (
                  <span className="ml-2 text-xs" style={muted}>
                    this device
                  </span>
                ) : null}
              </div>
              <div className="text-xs" style={muted}>
                {s.ipAddress ? `${s.ipAddress} · ` : ""}last used{" "}
                {formatDate(s.lastSeenAt)}
              </div>
            </div>
            {s.current ? null : (
              <button
                type="button"
                className="text-xs"
                style={{ color: "var(--color-danger)" }}
                onClick={() => revoke.mutate(s.id)}
              >
                Sign this one out
              </button>
            )}
          </li>
        ))}
      </ul>
      {revoke.error ? <ErrorNote error={revoke.error} /> : null}
    </Card>
  );
}
