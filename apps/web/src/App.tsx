import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type Meta, api } from "./lib/api";
import { authClient, useSession } from "./lib/auth";
import { Contacts } from "./routes/contacts";
import { Setup } from "./routes/setup";
import { SignIn } from "./routes/sign-in";

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
      api<{ needed: boolean; signUpOpen: boolean }>("/api/bootstrap"),
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
    return <Setup onDone={() => window.location.reload()} />;
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
        {active === "crm" ? (
          <Contacts />
        ) : (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            This module is enabled. Its screens arrive with the rest of Round 1.
          </p>
        )}
      </main>
    </div>
  );
}
