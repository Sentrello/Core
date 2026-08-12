import { registerBootstrapRoutes } from "@sentrello/auth/bootstrap";
import {
  mountAuth,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { runModuleMigrations } from "@sentrello/db/module-migrations";
import { startJobs } from "@sentrello/jobs";
import bookkeeping from "@sentrello/module-bookkeeping";
import crm from "@sentrello/module-crm";
import forms from "@sentrello/module-forms";
import invoicing from "@sentrello/module-invoicing";
import type { SentrelloEnv, SentrelloModule } from "@sentrello/module-sdk";
import settings from "@sentrello/module-settings";
import { Hono } from "hono";
import { resolveLicense } from "./license";
import { loadModules } from "./loader";
import { serveModuleUi } from "./module-ui";
import { discoverOptionalModules } from "./optional-modules";
import { serveWeb } from "./static";

const app = new Hono<SentrelloEnv>();
mountAuth(app);
registerBootstrapRoutes(app);

const { state, gate } = await resolveLicense();

// Free modules ship in this repo; commercial bundles are discovered at runtime
// only if installed. The loader then drops any this instance is not entitled to.
const modules: SentrelloModule[] = [
  crm,
  forms,
  invoicing,
  bookkeeping,
  settings,
  ...(await discoverOptionalModules()),
];
const { nav, loaded, jobs } = loadModules(app, gate, modules);

// A module brings its own tables. Applying them here — after the licence has
// decided what loads — means a customer who buys a module gets its schema on the
// next restart, and one they are not entitled to never touches their database.
for (const module of modules) {
  if (!module.migrations || !loaded.includes(module.id)) continue;
  try {
    await runModuleMigrations(module.migrations.dir, module.migrations.table);
    console.log(`[modules] migrated ${module.id}`);
  } catch (err) {
    // A module whose schema failed must not take the whole instance down: the
    // rest of the business still needs to invoice today.
    console.error(
      `[modules] ${module.id} migrations failed, its features may not work: ${(err as Error).message}`,
    );
  }
}

app.get("/healthz", (c) =>
  c.json({
    status: "ok",
    tier: state.claims?.tier ?? "free",
    license_valid: state.valid,
    modules_loaded: loaded,
  }),
);

const uiModules = serveModuleUi(app, modules, loaded);

app.get("/api/_meta", (c) => c.json({ nav, loaded, ui: uiModules }));

/**
 * What this instance is licensed for.
 *
 * The first question anyone asks when a feature disappears is "has something
 * expired?", and until now the only way to answer it was to read a JWT off the
 * server. Behind a session and the settings permission: it names the licence
 * and the modules bought, which is not something to hand to the internet.
 */
app.get(
  "/api/license",
  requireSession(),
  requirePermission({ settings: ["read"] }),
  (c) => {
    const claims = state.claims;
    const expiresAt =
      typeof claims?.exp === "number"
        ? new Date(claims.exp * 1000).toISOString()
        : null;

    return c.json({
      tier: claims?.tier ?? "free",
      valid: state.valid,
      // Present when the licence failed to verify, so the screen can say why
      // rather than only that something is wrong.
      reason: state.reason ?? null,
      modules: claims?.modules ?? [],
      seats: claims?.seats ?? null,
      instanceId: claims?.instance_id ?? null,
      // The token is short-lived and refreshed nightly; this is the deadline
      // for that refresh, not the end of the subscription.
      tokenExpiresAt: expiresAt,
      graceUntil: claims?.grace_until ?? null,
      modulesLoaded: loaded,
    });
  },
);

// last: everything unclaimed is the SPA
serveWeb(app);

// Jobs run only in the real server process, never when a test imports this file.
if (import.meta.main) {
  await startJobs(jobs);
}

const port = Number(process.env.PORT ?? 3000);
console.log(
  `Sentrello on :${port} (tier=${state.claims?.tier ?? "free"}, modules=${loaded.join(",")})`,
);
export default { port, fetch: app.fetch };
