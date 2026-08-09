import { mountAuth } from "@sentrello/auth/hono";
import { startJobs } from "@sentrello/jobs";
import bookkeeping from "@sentrello/module-bookkeeping";
import crm from "@sentrello/module-crm";
import invoicing from "@sentrello/module-invoicing";
import type { SentrelloEnv, SentrelloModule } from "@sentrello/module-sdk";
import { Hono } from "hono";
import { resolveLicense } from "./license";
import { loadModules } from "./loader";
import { discoverOptionalModules } from "./optional-modules";

const app = new Hono<SentrelloEnv>();
mountAuth(app);

const { state, gate } = await resolveLicense();

// Free modules ship in this repo; commercial bundles are discovered at runtime
// only if installed. The loader then drops any this instance is not entitled to.
const modules: SentrelloModule[] = [
  crm,
  invoicing,
  bookkeeping,
  ...(await discoverOptionalModules()),
];
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
