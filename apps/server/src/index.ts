import { roles } from "@sentrello/auth";
import { registerBootstrapRoutes } from "@sentrello/auth/bootstrap";
import {
  activeOrganizationId,
  mountAuth,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import { runModuleMigrations } from "@sentrello/db/module-migrations";
import {
  isEnabled,
  moduleStates,
  setModuleEnabled,
} from "@sentrello/db/modules";
import { and, eq } from "@sentrello/db/orm";
import { mailConfigured } from "@sentrello/email";
import { startJobs } from "@sentrello/jobs";
import bookkeeping from "@sentrello/module-bookkeeping";
import crm from "@sentrello/module-crm";
import dashboard from "@sentrello/module-dashboard";
import forms from "@sentrello/module-forms";
import invoicing from "@sentrello/module-invoicing";
import profile from "@sentrello/module-profile";
import type { SentrelloEnv, SentrelloModule } from "@sentrello/module-sdk";
import settings from "@sentrello/module-settings";
import { Hono } from "hono";
import { resolveLicense } from "./license";
import { loadModules } from "./loader";
import { serveModuleUi } from "./module-ui";
import { discoverOptionalModules, failedBundles } from "./optional-modules";
import { serveWeb } from "./static";

const app = new Hono<SentrelloEnv>();
mountAuth(app);
registerBootstrapRoutes(app);

const { state, gate } = await resolveLicense();

// Free modules ship in this repo; commercial bundles are discovered at runtime
// only if installed. The loader then drops any this instance is not entitled to.
const modules: SentrelloModule[] = [
  dashboard,
  crm,
  forms,
  invoicing,
  bookkeeping,
  settings,
  profile,
  ...(await discoverOptionalModules()),
];
const { nav, navVisibility, navPermissions, tiers, loaded, jobs } = loadModules(
  app,
  gate,
  modules,
);

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

/**
 * Baked into the image at build time, so an instance can say what it is
 * running without anyone needing shell access to the host. "Which version are
 * you on?" is the first question of every support conversation, and until now
 * the only way to answer it was `docker inspect`.
 */
const VERSION = process.env.SENTRELLO_VERSION ?? "unknown";

app.get("/healthz", (c) =>
  c.json({
    status: "ok",
    version: VERSION,
    tier: state.claims?.tier ?? "free",
    license_valid: state.valid,
    modules_loaded: loaded,
    // Named, not detailed: enough for monitoring to alert on, without
    // publishing an error message to anyone who can reach /healthz.
    modules_failed: failedBundles.map((f) => f.name),
  }),
);

const uiModules = serveModuleUi(app, modules, loaded);

/**
 * `version` is here so the SPA can key module scripts by release.
 *
 * A module screen is cached for five minutes with no version in its URL, so
 * for five minutes after an upgrade a customer can be running the previous
 * release's screen against the new API. Five minutes of a subtly wrong screen
 * is a support ticket nobody can reproduce.
 */
/**
 * What this instance is running, for the shell to build itself from.
 *
 * Behind a session. It names the version and every module the business
 * bought, which is the first thing anyone probing an instance wants and none
 * of it is any use before signing in — the sign-in page reads `/api/_signin`.
 *
 * Nav entries a module marked as narrower than the instance are dropped here
 * rather than hidden in the browser, so an entry somebody is not offered is
 * genuinely absent from what they are sent.
 */
app.get("/api/_meta", requireSession(), async (c) => {
  const session = c.get("session");
  // Read directly rather than through `activeOrganizationId`, which throws by
  // design so a business query can never lose its org filter. This is not a
  // business query: somebody signed in but not yet a member of anything still
  // needs a shell to look at, and they simply have no modules set up.
  const orgId = session.session.activeOrganizationId;
  const states = orgId ? await moduleStates(orgId) : new Map();

  /**
   * The role this person holds here, for filtering the nav by what they may
   * actually open.
   *
   * A role defined by the business itself is not in the compiled set, and a
   * permission this cannot evaluate is left visible rather than hidden — the
   * routes are guarded either way, and hiding a screen somebody is entitled to
   * is the worse mistake of the two.
   */
  const [membership] = orgId
    ? await db
        .select({ role: schema.member.role })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.userId, session.user.id),
            eq(schema.member.organizationId, orgId),
          ),
        )
        .limit(1)
    : [];
  const role = (
    roles as Record<string, { authorize: (r: unknown) => { success: boolean } }>
  )[membership?.role ?? ""];

  const visible = nav.filter((item) => {
    const allowed = navVisibility.get(item.id);
    if (allowed && !allowed(session)) return false;

    // A module the licence grants but nobody has set up belongs under Modules
    // with a way to start, not in the sidebar as a screen that half works.
    if (
      tiers.get(item.moduleId) === "module" &&
      !isEnabled(states, item.moduleId)
    ) {
      return false;
    }

    // And a screen this person cannot open should not be offered. Being
    // refused after clicking tells somebody twice that they cannot do their
    // job: once by the error, and once by the menu that suggested otherwise.
    const needs = navPermissions.get(item.id);
    if (!needs || !role) return true;
    return role.authorize(needs).success;
  });

  return c.json({
    nav: visible,
    loaded,
    /**
     * Every optional module this licence allows, and whether it is set up.
     *
     * The Modules screen is built from this. It carries the state rather than
     * only the unused ones, so the screen never has to work out which of the
     * loaded modules are optional — a guess the browser would get wrong the
     * first time a Free module was renamed.
     */
    modules: loaded
      .filter((id) => tiers.get(id) === "module")
      .map((id) => ({
        id,
        label: nav.find((n) => n.moduleId === id)?.label ?? id,
        enabled: isEnabled(states, id),
      })),
    ui: uiModules,
    version: VERSION,
  });
});

/**
 * Turning an optional module on, or putting it away again.
 *
 * Turning one off hides it and stops it being offered; it never deletes
 * anything. A business that switches scheduling off in the winter and back on
 * in the spring should find its diary where it left it.
 */
app.post(
  "/api/modules/:id",
  requireSession(),
  requirePermission({ settings: ["update"] }),
  async (c) => {
    const id = c.req.param("id");
    if (tiers.get(id) !== "module") {
      // Free modules are the product, not a purchase. A business that could
      // turn off invoicing would be one support call from an instance that
      // cannot invoice.
      return c.json({ error: "that module is not optional" }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      enabled?: unknown;
    };
    await setModuleEnabled(
      activeOrganizationId(c.get("session")),
      id,
      body.enabled === true,
    );
    return c.json({ id, enabled: body.enabled === true });
  },
);

/**
 * What the sign-in page needs before anyone has signed in.
 *
 * Only whether mail works, never how it is configured. A password reset on an
 * instance with no mail set up would tell the only administrator to check an
 * inbox nothing will arrive in, so the page has to know in advance to offer
 * the host command instead.
 */
app.get("/api/_signin", (c) => c.json({ mailConfigured: mailConfigured() }));

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
      // Behind the settings permission, so this one carries the reason.
      failedBundles,
    });
  },
);

// last: everything unclaimed is the SPA
serveWeb(app);

// Jobs run only in the real server process, never when a test imports this file.
if (import.meta.main) {
  // The tier decides whether the overdue chase goes out under Sentrello's name
  // or the business's own; a job has no request to read the licence from.
  await startJobs(jobs, {
    tier: state.claims?.tier === "pro" ? "pro" : "free",
    // Only reaches anywhere if this instance was asked at install time and
    // said yes; the job checks that itself.
    modules: loaded,
  });
}

const port = Number(process.env.PORT ?? 3000);
console.log(
  `Sentrello on :${port} (tier=${state.claims?.tier ?? "free"}, modules=${loaded.join(",")})`,
);
export default { port, fetch: app.fetch };
