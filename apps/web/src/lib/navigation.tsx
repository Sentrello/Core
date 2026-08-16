import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Where you are, and how you got there.
 *
 * The old model was a module id in a `useState` — enough to answer "which
 * screen", and nothing else. It is why the application cannot currently show
 * what connects to what: a deal has no way to open the contact it belongs to,
 * because there is nowhere to say "the contact, this one" and nothing to
 * remember you came from the deal.
 *
 * This is the smallest thing that fixes that. A view names a module, and
 * optionally a record inside it. Opening one keeps the trail, so a screen can
 * offer the way back — which is what a chain of contact → deal → invoice needs
 * in order not to feel like getting lost.
 */
export interface View {
  /** The module that owns the screen — matches what the server registered. */
  moduleId: string;
  /** A record within it. Absent means the module's list. */
  recordId?: string;
  /** What to call this in a breadcrumb. */
  title: string;
}

interface Navigation {
  current: View;
  /** Everything opened to get here, oldest first, excluding `current`. */
  trail: View[];
  /** Open a view, remembering where you were. */
  open: (view: View) => void;
  /** Jump to a module's list, forgetting the trail — a top-nav click. */
  go: (moduleId: string, title: string) => void;
  /** Step back to a point in the trail. */
  backTo: (index: number) => void;
}

const NavigationContext = createContext<Navigation | null>(null);

export function NavigationProvider({
  initial,
  children,
}: {
  initial: View;
  children: React.ReactNode;
}) {
  const [current, setCurrent] = useState<View>(initial);
  const [trail, setTrail] = useState<View[]>([]);

  // `open` reads the view it is leaving. A ref keeps that out of its dependency
  // list, so the callback stays stable and every screen does not re-render on
  // each navigation.
  const currentRef = useRef(current);
  currentRef.current = current;

  const open = useCallback((view: View) => {
    setTrail((t) => {
      // Re-opening something already in the trail is going back to it, not
      // deeper — otherwise a contact → deal → same contact grows for ever and
      // the breadcrumb becomes a lie.
      const seen = t.findIndex(
        (v) => v.moduleId === view.moduleId && v.recordId === view.recordId,
      );
      if (seen !== -1) return t.slice(0, seen);
      return [...t, currentRef.current];
    });
    setCurrent(view);
  }, []);

  const go = useCallback((moduleId: string, title: string) => {
    setTrail([]);
    setCurrent({ moduleId, title });
  }, []);

  const backTo = useCallback((index: number) => {
    setTrail((t) => {
      const target = t[index];
      if (target) setCurrent(target);
      return t.slice(0, index);
    });
  }, []);

  const value = useMemo<Navigation>(
    () => ({ current, trail, open, go, backTo }),
    [current, trail, open, go, backTo],
  );

  return (
    <NavigationContext.Provider value={value}>
      {children}
    </NavigationContext.Provider>
  );
}

export function useNavigation(): Navigation {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error("useNavigation used outside NavigationProvider");
  return ctx;
}

/**
 * A link to a related record.
 *
 * The point of the whole file: a deal can render `<RelatedLink>` for its
 * contact, and the contact opens with a way back to the deal. Modules get this
 * without knowing anything about routing.
 */
export function RelatedLink({
  to,
  children,
}: {
  to: View;
  children: React.ReactNode;
}) {
  const { open } = useNavigation();
  return (
    <button
      type="button"
      onClick={() => open(to)}
      className="underline underline-offset-2"
      style={{ color: "var(--color-brand-500)" }}
    >
      {children}
    </button>
  );
}

/** The trail, rendered. Nothing at all when you are at the top. */
export function Breadcrumb() {
  const { trail, current, backTo } = useNavigation();
  if (!trail.length) return null;

  return (
    <nav className="breadcrumb mb-2 flex flex-wrap items-center gap-1">
      {trail.map((view, i) => (
        <span key={`${view.moduleId}-${view.recordId ?? "list"}`}>
          <button type="button" onClick={() => backTo(i)}>
            {view.title}
          </button>
          <span className="mx-1">/</span>
        </span>
      ))}
      <span style={{ color: "var(--text)" }}>{current.title}</span>
    </nav>
  );
}
