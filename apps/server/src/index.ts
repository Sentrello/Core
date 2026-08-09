import { mountAuth } from "@sentrello/auth/hono";
import { startJobs } from "@sentrello/jobs";
import bookkeeping from "@sentrello/module-bookkeeping";
import crm from "@sentrello/module-crm";
import invoicing from "@sentrello/module-invoicing";
import type { SentrelloEnv, SentrelloModule } from "@sentrello/module-sdk";
import { Hono } from "hono";
import { resolveLicense } from "./license";
import { loadModules } from "./loader";

const app = new Hono<SentrelloEnv>();
mountAuth(app);

const { state, gate } = await resolveLicense();

// Pro/optional modules are added here when their bundles are present (Packet 03
// distribution); the loader ignores any this instance is not entitled to.
const modules: SentrelloModule[] = [crm, invoicing, bookkeeping];
const { nav, loaded } = loadModules(app, gate, modules);

app.get("/healthz", (c) =>
  c.json({
    status: "ok",
    tier: state.claims?.tier ?? "free",
    license_valid: state.valid,
    modules_loaded: loaded,
  }),
);

app.get("/api/_meta", (c) => c.json({ nav, loaded }));

// Jobs run only in the real server process, never when a test imports this file.
if (import.meta.main) {
  await startJobs();
}

const port = Number(process.env.PORT ?? 3000);
console.log(
  `Sentrello on :${port} (tier=${state.claims?.tier ?? "free"}, modules=${loaded.join(",")})`,
);
export default { port, fetch: app.fetch };
