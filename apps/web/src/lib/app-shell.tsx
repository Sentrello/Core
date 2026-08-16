import { useEffect, useRef, useState } from "react";
import { authClient } from "./auth";
import { useNavigation } from "./navigation";
import { type Theme, useTheme } from "./theme";

/**
 * The frame every screen sits in.
 *
 * A top header rather than the sidebar it replaces. The sidebar listed modules
 * as equals, which is exactly the thing that made it hard to tell what
 * connects to what — eight unrelated items, no sense that a contact leads to a
 * deal leads to an invoice. A header leaves the full width for a record and
 * whatever it is related to, which is where that relationship has to be shown.
 */

interface NavEntry {
  id: string;
  label: string;
  moduleId?: string;
}

/** Initials, for when there is no avatar — which is the normal case. */
function initials(name: string | null | undefined, email: string): string {
  const source = name?.trim() || email;
  const parts = source
    .replace(/@.*/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => p[0] ?? "");
  return (letters.join("") || source[0] || "?").toUpperCase();
}

function ThemeChoice({
  theme,
  onChange,
}: {
  theme: Theme;
  onChange: (t: Theme) => void;
}) {
  return (
    <div
      className="flex gap-1 border-t px-3 py-2"
      style={{ borderColor: "var(--border)" }}
    >
      {(["light", "dark", "system"] as const).map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onChange(t)}
          aria-pressed={theme === t}
          className="flex-1 rounded px-2 py-1 text-xs capitalize"
          style={
            theme === t
              ? {
                  background: "var(--color-brand-500)",
                  color: "var(--color-neutral-50)",
                }
              : { color: "var(--text-muted)" }
          }
        >
          {t}
        </button>
      ))}
    </div>
  );
}

function ProfileMenu({
  name,
  email,
  onOpenSettings,
}: {
  name: string | null | undefined;
  email: string;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const box = useRef<HTMLDivElement>(null);

  // Closing on an outside click and on Escape, because a menu that can only be
  // dismissed by the button that opened it is a menu people get stuck in.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Your account"
        className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold"
        style={{
          background: "var(--color-brand-500)",
          color: "var(--color-neutral-50)",
        }}
      >
        {initials(name, email)}
      </button>

      {open ? (
        <div className="menu-panel" role="menu">
          <div
            className="border-b px-3 py-2"
            style={{ borderColor: "var(--border)" }}
          >
            <div className="truncate text-sm font-medium">{name || email}</div>
            {name ? (
              <div
                className="truncate text-xs"
                style={{ color: "var(--text-muted)" }}
              >
                {email}
              </div>
            ) : null}
          </div>

          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            Settings
          </button>

          <ThemeChoice theme={theme} onChange={setTheme} />

          <button
            type="button"
            role="menuitem"
            className="menu-item border-t"
            style={{
              borderColor: "var(--border)",
              color: "var(--color-danger)",
            }}
            onClick={() => authClient.signOut()}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function AppShell({
  nav,
  user,
  children,
}: {
  nav: NavEntry[];
  user: { name?: string | null; email: string };
  children: React.ReactNode;
}) {
  const { current, go } = useNavigation();

  // Settings lives in the profile menu rather than the nav: it is where you go
  // occasionally, and giving it equal billing with the work crowds the things
  // people use every day.
  const visible = nav.filter((n) => n.id !== "settings");
  const settings = nav.find((n) => n.id === "settings");

  return (
    <div className="min-h-screen">
      <header className="app-header">
        <div className="flex items-center gap-3 px-4 py-2">
          <button
            type="button"
            onClick={() => {
              const first = visible[0];
              if (first) go(first.id, first.label);
            }}
            className="shrink-0 font-semibold"
          >
            Sentrello
          </button>

          {/* Scrolls rather than wraps: a business with every module bought has
              a lot of these, and a header that grows to two rows pushes the
              work down the page on every screen. */}
          <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
            {visible.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => go(n.id, n.label)}
                aria-current={current.moduleId === n.id ? "page" : undefined}
                className="nav-link"
              >
                {n.label}
              </button>
            ))}
          </nav>

          <ProfileMenu
            name={user.name}
            email={user.email}
            onOpenSettings={() => settings && go(settings.id, settings.label)}
          />
        </div>
      </header>

      <main className="mx-auto max-w-7xl p-6">{children}</main>
    </div>
  );
}
