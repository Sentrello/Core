import { useEffect, useRef, useState } from "react";
import { authClient } from "./auth";
import { Icon, type IconName } from "./icons";
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
  /** Set on a module's own pages: the id of the entry they sit under. */
  parent?: string;
  icon?: string;
}

/**
 * Sections, in the order a business works through them rather than
 * alphabetically: find the customer, agree the price, take the money, do the
 * job. A section the host has never heard of sorts to the end rather than
 * being dropped — a module may name its own.
 */
const GROUP_ORDER = ["Sales", "Money", "Work", "People", "Configure"];

/** Whatever the rail should draw for a section that named no icon of its own. */
const GROUP_ICONS: Record<string, IconName> = {
  Sales: "contact",
  Money: "receipt",
  Work: "briefcase",
  People: "users",
  Configure: "settings",
};

export function sections(
  nav: NavEntry[],
): { name: string; items: NavEntry[] }[] {
  const byGroup = new Map<string, NavEntry[]>();
  // Only top-level entries form sections. A module's own pages belong to their
  // parent and are drawn beneath it, not beside it.
  for (const item of nav.filter((n) => !n.parent)) {
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

/** A module's own pages, in the order it registered them. */
export function childrenOf(nav: NavEntry[], parentId: string): NavEntry[] {
  return nav.filter((n) => n.parent === parentId);
}

/**
 * The sidebar, in two levels.
 *
 * A rail of sections on the left, and the section you are in opened beside it.
 * One flat list of every screen said nothing about what belongs with what —
 * fifteen equal items, with the CRM's five pages burying the Shop. The rail
 * says "these are the parts of the business"; the panel says "this is what is
 * in this part"; and a module with several screens opens into them.
 */
function Sidebar({ nav }: { nav: NavEntry[] }) {
  const { current, go } = useNavigation();
  const groups = sections(nav);

  /** Which entry is on screen, so the rail and the panel can both mark it. */
  const activeEntry = nav.find((n) => n.id === current.moduleId);
  const activeGroup = activeEntry?.parent
    ? (nav.find((n) => n.id === activeEntry.parent)?.group ?? "")
    : (activeEntry?.group ?? "");

  /**
   * The section the panel is showing.
   *
   * It follows wherever you are by default, so arriving on a screen opens the
   * part of the business it belongs to. Clicking the rail pins a different one
   * — somebody looking for the next thing to do should be able to browse
   * without leaving the screen they are on.
   */
  const [pinned, setPinned] = useState<string | null>(null);
  const shown = pinned ?? activeGroup;
  const section = groups.find((g) => g.name === shown) ?? groups[0];

  /** Modules opened out into their pages. Expanded where you are working. */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isOpen = (entry: NavEntry) =>
    expanded[entry.id] ??
    (current.moduleId === entry.id || activeEntry?.parent === entry.id);

  /** A parent is not a screen: opening one opens the first page under it. */
  const openEntry = (entry: NavEntry) => {
    const pages = childrenOf(nav, entry.id);
    const first = pages[0];
    if (first) {
      setExpanded((e) => ({ ...e, [entry.id]: true }));
      go(first.id, first.label);
      return;
    }
    go(entry.id, entry.label);
  };

  return (
    <div className="flex items-stretch">
      <nav className="app-rail" aria-label="Sections">
        {groups.map((group) => {
          // The unnamed section holds the Dashboard and anything else with no
          // home. It gets a place on the rail like the rest.
          const name = group.name || "Home";
          const icon =
            group.items.find((i) => i.icon)?.icon ??
            GROUP_ICONS[group.name] ??
            "layout";
          const here = shown === group.name;
          return (
            <button
              key={name}
              type="button"
              className="rail-button"
              aria-label={name}
              title={name}
              aria-current={here ? "true" : undefined}
              onClick={() => {
                setPinned(group.name);
                // A rail click with nothing under it should still go
                // somewhere: an icon that only ever highlights is a dead end.
                if (group.items.length === 1 && group.items[0]) {
                  openEntry(group.items[0]);
                }
              }}
            >
              <Icon name={icon as IconName} size={20} />
            </button>
          );
        })}
      </nav>

      <aside className="app-sidebar p-2" aria-label="Screens">
        {section ? (
          <>
            <p className="panel-title">{section.name || "Home"}</p>
            {section.items.map((entry) => {
              const pages = childrenOf(nav, entry.id);
              const open = isOpen(entry);
              const activeHere =
                current.moduleId === entry.id ||
                pages.some((p) => p.id === current.moduleId);

              return (
                <div key={entry.id}>
                  <button
                    type="button"
                    className="nav-link nav-parent"
                    aria-current={
                      activeHere && pages.length === 0 ? "page" : undefined
                    }
                    aria-expanded={pages.length ? open : undefined}
                    onClick={() => {
                      if (pages.length) {
                        // Already looking at one of its pages: fold it away
                        // rather than reopening what is already open.
                        setExpanded((e) => ({ ...e, [entry.id]: !open }));
                        if (!open) openEntry(entry);
                      } else {
                        openEntry(entry);
                      }
                    }}
                  >
                    <Icon
                      name={(entry.icon ?? "layout") as IconName}
                      size={16}
                    />
                    <span className="flex-1 text-left">{entry.label}</span>
                    {pages.length ? (
                      <span className="nav-caret" data-open={open}>
                        ▸
                      </span>
                    ) : null}
                  </button>

                  {pages.length && open ? (
                    <div className="nav-children">
                      {pages.map((page) => (
                        <button
                          key={page.id}
                          type="button"
                          className="nav-link nav-child"
                          aria-current={
                            current.moduleId === page.id ? "page" : undefined
                          }
                          onClick={() => go(page.id, page.label)}
                        >
                          {page.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </>
        ) : null}
      </aside>
    </div>
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
