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

export interface NavEntry {
  id: string;
  label: string;
  moduleId?: string;
  group?: string;
}

/**
 * Sections, in the order a business works through them rather than
 * alphabetically: find the customer, agree the price, take the money, do the
 * job. A section the host has never heard of sorts to the end rather than
 * being dropped — a module may name its own.
 */
/**
 * CRM first: it is the section people open most, and it is the one the whole
 * platform hangs off — a contact is what an invoice, a job and a booking are
 * all eventually about. "Sales" keeps the things that sell rather than the
 * people they are sold to: the Shop, and Make Deal.
 */
const GROUP_ORDER = ["CRM", "Sales", "Money", "Work", "People", "Configure"];

export function sections(
  nav: NavEntry[],
): { name: string; items: NavEntry[] }[] {
  const byGroup = new Map<string, NavEntry[]>();
  for (const item of nav) {
    const key = item.group ?? "";
    const list = byGroup.get(key);
    if (list) list.push(item);
    else byGroup.set(key, [item]);
  }
  /**
   * Where a section sits.
   *
   * An entry with no section is a top-level one — the Dashboard is the only
   * one today — and it belongs above the sections rather than below them. It
   * used to share its position with "a section nobody recognises", so the
   * first thing anybody sees on signing in was the last thing in the sidebar.
   *
   * A named section the host has never heard of still sorts to the end: a
   * module may invent one, and putting it last is better than guessing where
   * in somebody's working day it belongs.
   */
  const position = (name: string) => {
    if (name === "") return -1;
    const known = GROUP_ORDER.indexOf(name);
    return known === -1 ? 99 : known;
  };

  return [...byGroup.entries()]
    .map(([name, items]) => ({ name, items }))
    .sort((a, b) => position(a.name) - position(b.name));
}

function Sidebar({ nav }: { nav: NavEntry[] }) {
  const { current, go } = useNavigation();
  const groups = sections(nav);

  // Everything open to begin with. A collapsed sidebar hides the thing
  // somebody is looking for, and the point of sections is to show how the work
  // fits together — which cannot happen if it is folded away by default.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  return (
    <aside className="app-sidebar p-2">
      {groups.map((group) => {
        const open = !collapsed[group.name];
        // A section with no name is not a section: render its items plainly
        // rather than inventing a heading for them.
        if (!group.name) {
          return group.items.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => go(n.id, n.label)}
              aria-current={current.moduleId === n.id ? "page" : undefined}
              className="nav-link"
            >
              {n.label}
            </button>
          ));
        }
        return (
          <div key={group.name} className="mb-1">
            <button
              type="button"
              className="nav-group-toggle"
              aria-expanded={open}
              onClick={() =>
                setCollapsed((c) => ({ ...c, [group.name]: open }))
              }
            >
              <span className="nav-caret" data-open={open}>
                ▶
              </span>
              <span className="nav-group-label">{group.name}</span>
            </button>
            {open ? (
              <div className="mt-0.5 space-y-0.5">
                {group.items.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => go(n.id, n.label)}
                    aria-current={
                      current.moduleId === n.id ? "page" : undefined
                    }
                    className="nav-link"
                  >
                    {n.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </aside>
  );
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
  onOpenProfile,
  onOpenSettings,
}: {
  name: string | null | undefined;
  email: string;
  onOpenProfile: () => void;
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
              onOpenProfile();
            }}
          >
            Your profile
          </button>

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
  const { go } = useNavigation();

  // Settings reaches the sidebar under Configure and the profile menu both.
  // Two ways to the same screen is not duplication here: one is where you look
  // when configuring the platform, the other where you look when it is your
  // own account you are thinking about.
  const settings = nav.find((n) => n.id === "settings");
  const first = nav.find((n) => n.id !== "settings") ?? nav[0];

  return (
    <div className="min-h-screen">
      {/* Global: who you are, and the way home. The modules are not up here —
          fifteen of them scrolling sideways told you nothing about how they
          relate, which was the whole complaint. */}
      <header className="app-header">
        <div className="flex h-13 items-center gap-3 px-4 py-2">
          <button
            type="button"
            onClick={() => first && go(first.id, first.label)}
            className="shrink-0 font-semibold"
          >
            Sentrello
          </button>
          <div className="flex-1" />
          <ProfileMenu
            name={user.name}
            email={user.email}
            // No nav entry of its own: your account is not one of the
            // business's modules, and it is reached from here or not at all.
            onOpenProfile={() => go("profile", "Your profile")}
            onOpenSettings={() => settings && go(settings.id, settings.label)}
          />
        </div>
      </header>

      <div className="flex items-start">
        <Sidebar nav={nav} />
        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
