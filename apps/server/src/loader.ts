import type {
  EntitlementNeed,
  SentrelloEnv,
  SentrelloModule,
} from "@sentrello/module-sdk";
import type { Hono } from "hono";

export function loadModules(
  app: Hono<SentrelloEnv>,
  entitled: (need: EntitlementNeed) => boolean,
  modules: SentrelloModule[],
) {
  const nav: { id: string; label: string; order?: number }[] = [];
  const permissions: string[] = [];
  const jobs: { name: string; cron?: string }[] = [];
  const loaded = new Set<string>();

  // simple dependency-aware pass; repeat until no progress
  let progress = true;
  while (progress) {
    progress = false;
    for (const m of modules) {
      if (loaded.has(m.id)) continue;
      const tierOk =
        m.tier === "free" ||
        (m.tier === "pro" && entitled({ tier: "pro" })) ||
        (m.tier === "module" && entitled({ module: m.id }));
      const depsOk = (m.requires ?? []).every((d) => loaded.has(d));
      if (!tierOk || !depsOk) continue;
      m.register({
        app,
        entitled,
        registerNav: (i) => nav.push(i),
        registerPermission: (p) => permissions.push(p),
        registerJob: (j) => jobs.push({ name: j.name, cron: j.cron }),
      });
      loaded.add(m.id);
      progress = true;
    }
  }
  nav.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return { nav, permissions, jobs, loaded: [...loaded] };
}
