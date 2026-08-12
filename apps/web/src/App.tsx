import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type Meta, api } from "./lib/api";
import { authClient, useSession } from "./lib/auth";
import { Bookkeeping } from "./routes/bookkeeping";
import { Contacts } from "./routes/contacts";
import { Forms } from "./routes/forms";
import { Invoices } from "./routes/invoices";
import { ModuleScreen } from "./routes/module-screen";
import { Settings } from "./routes/settings";
import { Setup } from "./routes/setup";
import { SignIn } from "./routes/sign-in";

/**
 * Which screen a nav entry opens.
 *
 * Keyed by the module id the server registered, so a module the licence does
 * not load has no nav entry and no way in. A module whose screens ship
 * elsewhere simply has no entry here yet.
 */
const SCREENS: Record<string, () => React.ReactElement | null> = {
  crm: Contacts,
  invoicing: Invoices,
  bookkeeping: Bookkeeping,
  forms: Forms,
  settings: Settings,
};

function useMeta() {
  return useQuery({
    queryKey: ["meta"],
    queryFn: () => api<Meta>("/api/_meta"),
  });
}

/**
 * The nav renders only what the server loaded, which is only what the license
 * entitles — the UI can never show a feature the instance isn't licensed for.
 */
function useBootstrap() {
  return useQuery({
    queryKey: ["bootstrap"],
    queryFn: () =>
      api<{
        needed: boolean;
        signUpOpen: boolean;
        setupTokenRequired: boolean;
      }>("/api/bootstrap"),
    staleTime: 0,
  });
}

export default function App() {
  const { data } = useMeta();
  const session = useSession();
  const bootstrap = useBootstrap();
  const nav = data?.nav ?? [];
  const [active, setActive] = useState("crm");

  if (session.isPending || bootstrap.isLoading) return null;
  // A fresh instance has no owner yet: claim it before anything else.
  if (bootstrap.data?.needed) {
    return (
      <Setup
        tokenRequired={bootstrap.data.setupTokenRequired}
        onDone={() => window.location.reload()}
      />
    );
  }
  if (!session.data) return <SignIn />;

  return (
    <div className="flex min-h-screen">
      <aside
        className="w-56 border-r p-4"
        style={{ borderColor: "var(--border)" }}
      >
        <div className="mb-4 font-semibold">Sentrello</div>
        <button
          type="button"
          onClick={() => authClient.signOut()}
          className="mb-4 text-xs"
          style={{ color: "var(--text-muted)" }}
        >
          Sign out
        </button>
        <nav className="space-y-1">
          {nav.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => setActive(n.id)}
              className="block w-full rounded px-2 py-1 text-left text-sm"
              style={
                active === n.id
                  ? {
                      background: "var(--color-brand-500)",
                      color: "var(--color-neutral-50)",
                    }
                  : undefined
              }
            >
              {n.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="flex-1 p-6">
        <h1 className="mb-4 text-lg font-semibold">
          {nav.find((n) => n.id === active)?.label ?? "Dashboard"}
        </h1>
        {(() => {
          const Screen = SCREENS[active];
          if (Screen) return <Screen />;
          // Not a Core screen: the module may have shipped its own. The
          // script is fetched by module id, which is not always the nav id.
          const entry = nav.find((n) => n.id === active);
          return (
            <ModuleScreen
              moduleId={entry?.moduleId ?? active}
              screenId={active}
              label={entry?.label ?? active}
            />
          );
        })()}
      </main>
    </div>
  );
}
