import type { ModuleJob } from "@sentrello/jobs";
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
  // The nav id is the module's choice and need not match its module id —
  // "time-tracking" registers a "Time" entry — so each item carries the module
  // it came from, which is what the browser needs to fetch its screens.
  const nav: {
    id: string;
    label: string;
    order?: number;
    moduleId: string;
  }[] = [];
  const permissions: string[] = [];
  const jobs: ModuleJob[] = [];
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
        registerNav: (i) => nav.push({ ...i, moduleId: m.id }),
        registerPermission: (p) => permissions.push(p),
        // namespaced: two modules may both want a job called "reminders"
        registerJob: (j) => jobs.push({ ...j, name: `${m.id}:${j.name}` }),
      });
      loaded.add(m.id);
      progress = true;
    }
  }
  nav.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return { nav, permissions, jobs, loaded: [...loaded] };
}
