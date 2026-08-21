import { afterAll, expect, test } from "bun:test";
import { auth, roles } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { isEnabled } from "@sentrello/db/modules";
import { eq, like } from "@sentrello/db/orm";
import { type SentrelloEnv, defineModule } from "@sentrello/module-sdk";
import { Hono } from "hono";
import { resolveLicense } from "./license";
import { loadModules } from "./loader";

/**
 * A signed-in caller, because `/api/_meta` names the version and every module
 * a business bought — the first thing anyone probing an instance wants, and
 * none of it any use before signing in.
 */
async function signedIn(): Promise<{
  headers: Headers;
  email: string;
  organizationId: string;
  cleanUp: () => Promise<void>;
}> {
  const email = `boot-${crypto.randomUUID().slice(0, 8)}@x.test`;
  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const headers = new Headers({ cookie });

  /**
   * And a business to belong to, because the real first-run path creates one:
   * `/api/bootstrap` signs the owner up and immediately creates their
   * organization. A signed-in user who is a member of nothing is a billing
   * account, not staff, and the shell now treats the two differently — so a
   * test that skipped this would be asserting against a person who does not
   * exist in production.
   */
  const suffix = crypto.randomUUID().slice(0, 8);
  const org = await auth.api.createOrganization({
    body: { name: `Boot ${suffix}`, slug: `boot-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create the test organization");
  await auth.api.setActiveOrganization({
    body: { organizationId: org.id },
    headers,
  });

  return {
    headers,
    email,
    organizationId: org.id,
    // Left behind, any owner makes the instance look claimed and every
    // bootstrap test then fails on a database this one dirtied.
    cleanUp: async () => {
      const [u] = await db
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.email, email));
      if (!u) return;
      await db.delete(schema.member).where(eq(schema.member.userId, u.id));
      await db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, org.id));
      await db.delete(schema.session).where(eq(schema.session.userId, u.id));
      await db.delete(schema.account).where(eq(schema.account.userId, u.id));
      await db.delete(schema.user).where(eq(schema.user.id, u.id));
    },
  };
}

/**
 * A safety net, because one missed cleanup poisons other files.
 *
 * Every sign-in here creates an organization — the real first-run path does,
 * so a test owner without one is a person who cannot exist. But an
 * organization left behind makes the instance look *claimed*, and the
 * bootstrap tests in another file then fail with 409s that have nothing to do
 * with them. That happened. Per-test cleanup still runs; this catches whatever
 * it misses.
 */
afterAll(async () => {
  const strays = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(like(schema.organizations.slug, "boot-%"));
  for (const org of strays) {
    await db
      .delete(schema.member)
      .where(eq(schema.member.organizationId, org.id));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, org.id));
  }

  const users = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(like(schema.user.email, "boot-%@x.test"));
  for (const u of users) {
    await db.delete(schema.session).where(eq(schema.session.userId, u.id));
    await db.delete(schema.account).where(eq(schema.account.userId, u.id));
    await db.delete(schema.user).where(eq(schema.user.id, u.id));
  }
});

const freeGate = () => false;
const proGate = (need: { tier?: "pro"; module?: string }) =>
  need.tier === "pro" || need.module === "hr";

function mod(id: string, tier: "free" | "pro" | "module", requires?: string[]) {
  return defineModule({
    id,
    tier,
    requires,
    register(ctx) {
      ctx.registerNav({ id, label: id, order: id === "crm" ? 10 : 20 });
      ctx.registerPermission(`${id}:read`);
      ctx.app.get(`/api/${id}`, (c) => c.json({ ok: id }));
    },
  });
}

test("free modules load without any license", () => {
  const app = new Hono<SentrelloEnv>();
  const { loaded, nav, permissions } = loadModules(app, freeGate, [
    mod("crm", "free"),
  ]);
  expect(loaded).toEqual(["crm"]);
  // the module that registered the entry travels with it: the browser fetches
  // that module's screens, and a nav id is not always a module id
  expect(nav).toEqual([
    { id: "crm", label: "crm", order: 10, moduleId: "crm" },
  ]);
  expect(permissions).toEqual(["crm:read"]);
});

test("pro + entitled optional modules load only when the gate allows", () => {
  const modules = [
    mod("crm", "free"),
    mod("pro-core", "pro"),
    mod("hr", "module"),
    mod("inventory", "module"),
  ];

  const proLoaded = loadModules(
    new Hono<SentrelloEnv>(),
    proGate,
    modules,
  ).loaded;
  expect(proLoaded).toContain("pro-core");
  expect(proLoaded).toContain("hr");
  expect(proLoaded).not.toContain("inventory");

  const freeLoaded = loadModules(
    new Hono<SentrelloEnv>(),
    freeGate,
    modules,
  ).loaded;
  expect(freeLoaded).toEqual(["crm"]);
});

test("module with an unmet `requires` is skipped", () => {
  const { loaded } = loadModules(new Hono<SentrelloEnv>(), freeGate, [
    mod("reports", "free", ["pro-core"]),
    mod("crm", "free"),
  ]);
  expect(loaded).toEqual(["crm"]);
});

test("dependency order is respected regardless of array order", () => {
  const { loaded } = loadModules(new Hono<SentrelloEnv>(), freeGate, [
    mod("c", "free", ["b"]),
    mod("b", "free", ["a"]),
    mod("a", "free"),
  ]);
  expect(loaded).toEqual(["a", "b", "c"]);
});

test("a module's job reaches the host with its handler intact", async () => {
  let ran = 0;
  const withJob = defineModule({
    id: "scheduling",
    tier: "module",
    register(ctx) {
      ctx.registerJob({
        name: "reminders",
        cron: "*/15 * * * *",
        handler: async () => {
          ran += 1;
        },
      });
    },
  });

  const boughtScheduling = (need: { tier?: "pro"; module?: string }) =>
    need.module === "scheduling";

  const { jobs } = loadModules(new Hono<SentrelloEnv>(), boughtScheduling, [
    withJob,
    // this one was not bought, so its job must not be scheduled either
    defineModule({
      id: "inventory",
      tier: "module",
      register: (ctx) =>
        ctx.registerJob({ name: "reminders", handler: async () => {} }),
    }),
  ]);

  // namespaced, so two modules asking for "reminders" cannot collide
  expect(jobs.map((j) => j.name)).toEqual(["scheduling:reminders"]);
  expect(jobs[0]?.cron).toBe("*/15 * * * *");

  await jobs[0]?.handler();
  expect(ran).toBe(1);
});

test("a job from an unentitled module is never scheduled", () => {
  const { jobs } = loadModules(new Hono<SentrelloEnv>(), freeGate, [
    defineModule({
      id: "scheduling",
      tier: "module",
      register: (ctx) =>
        ctx.registerJob({
          name: "reminders",
          handler: async () => {
            throw new Error("must not run");
          },
        }),
    }),
  ]);
  expect(jobs).toEqual([]);
});

test("a skipped module registers no routes", async () => {
  const app = new Hono<SentrelloEnv>();
  loadModules(app, freeGate, [mod("hr", "module")]);
  const res = await app.request("http://localhost/api/hr");
  expect(res.status).toBe(404);
});

test("resolveLicense falls back to Free when the token file is missing", async () => {
  process.env.SENTRELLO_LICENSE_PUBLIC_KEY_PATH = "secrets/license_public.pem";
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const { state, gate } = await resolveLicense();
  expect(state.valid).toBe(false);
  expect(state.claims).toBeNull();
  expect(gate({ tier: "pro" })).toBe(false);
});

test("/healthz boots and reports Free when no token is present", async () => {
  process.env.SENTRELLO_LICENSE_PUBLIC_KEY_PATH = "secrets/license_public.pem";
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;
  const res = await server.fetch(new Request("http://localhost/healthz"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    status: "ok",
    // Baked into the image at build time; "unknown" outside a released one,
    // which is the honest answer when running from a checkout.
    version: "unknown",
    tier: "free",
    license_valid: false,
    modules_loaded: [
      "dashboard",
      "crm",
      "forms",
      "invoicing",
      "bookkeeping",
      "settings",
      "profile",
      "users",
    ],
    // A bundle that will not load is reported rather than only logged: it
    // takes every feature of that module with it.
    modules_failed: [],
  });
});

test("/healthz reports the version the image was built with", async () => {
  // "Which version are you on?" is the first question of every support
  // conversation, and the only way to answer it used to be docker inspect.
  process.env.SENTRELLO_LICENSE_PUBLIC_KEY_PATH = "secrets/license_public.pem";
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  process.env.SENTRELLO_VERSION = "9.9.9";

  // A fresh module registry, because index.ts reads the variable once at load.
  const mod = await import(`./index?version-test=${Date.now()}`);
  const res = await mod.default.fetch(new Request("http://localhost/healthz"));
  const body = (await res.json()) as { version: string };
  expect(body.version).toBe("9.9.9");

  process.env.SENTRELLO_VERSION = undefined;
});

test("/api/_meta exposes only the nav the loaded modules registered", async () => {
  process.env.SENTRELLO_LICENSE_PUBLIC_KEY_PATH = "secrets/license_public.pem";
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;

  // Anonymous callers are told nothing at all.
  const anonymous = await server.fetch(
    new Request("http://localhost/api/_meta"),
  );
  expect(anonymous.status).toBe(401);

  const { headers, cleanUp } = await signedIn();
  const res = await server.fetch(
    new Request("http://localhost/api/_meta", { headers }),
  );
  const body = (await res.json()) as {
    nav: { id: string }[];
    loaded: string[];
  };
  // sorted by the order each module registered, not by load order
  expect(body.nav.map((n) => n.id)).toEqual([
    "dashboard",
    "crm-dashboard",
    "crm",
    "companies",
    "deals",
    "crm-settings",
    "quotes",
    "invoicing",
    "forms",
    "bookkeeping",
    "settings",
    "users",
  ]);
  expect(body.loaded).not.toContain("pro-core");
  await cleanUp();
});

/**
 * The failure a real customer met.
 *
 * sentrello.com creates a billing account for every buyer, on the same
 * instance that runs the business's own books. Being a member of no
 * organization, that account was shown the entire sidebar — every screen
 * offered, every route refusing them after the click.
 */
test("somebody who belongs to no business is offered nothing at all", async () => {
  process.env.SENTRELLO_LICENSE_PUBLIC_KEY_PATH = "secrets/license_public.pem";
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;

  const { headers, email, cleanUp } = await signedIn();
  const [user] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));

  const before = (await (
    await server.fetch(new Request("http://localhost/api/_meta", { headers }))
  ).json()) as { nav: { id: string }[]; belongsHere: boolean };
  expect(before.nav.length).toBeGreaterThan(0);
  expect(before.belongsHere).toBe(true);

  // What a billing account is: a real login, a member of no business. Scoped
  // to this user, because other tests are entitled to their own memberships.
  await db
    .delete(schema.member)
    .where(eq(schema.member.userId, user?.id as string));

  const after = (await (
    await server.fetch(new Request("http://localhost/api/_meta", { headers }))
  ).json()) as {
    nav: { id: string }[];
    belongsHere: boolean;
    accountPath: string | null;
  };
  expect(after.nav).toEqual([]);
  expect(after.belongsHere).toBe(false);
  // Nothing to send them to on an instance that does not sell Sentrello.
  expect(after.accountPath).toBeNull();

  await cleanUp();
});

test("a module's screens are not served when the module did not load", async () => {
  process.env.SENTRELLO_LICENSE_PUBLIC_KEY_PATH = "secrets/license_public.pem";
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;

  // Free instance: scheduling is not loaded, so its script must 404 rather
  // than merely be hidden by the interface.
  const res = await server.fetch(
    new Request("http://localhost/modules/scheduling/ui.js"),
  );
  expect(res.status).toBe(404);

  const { headers, cleanUp } = await signedIn();
  const meta = (await (
    await server.fetch(new Request("http://localhost/api/_meta", { headers }))
  ).json()) as { ui: string[] };
  expect(meta.ui).toEqual([]);
  await cleanUp();
});

test("a module id cannot be used to reach a file off the map", async () => {
  process.env.SENTRELLO_LICENSE_PUBLIC_KEY_PATH = "secrets/license_public.pem";
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;

  for (const id of [
    "../../../etc/passwd",
    "..%2f..%2fpackage.json",
    "crm/../../secrets",
  ]) {
    const res = await server.fetch(
      new Request(`http://localhost/modules/${encodeURIComponent(id)}/ui.js`),
    );
    // The served path never comes from the request — the id is a map key, so
    // there is nothing to traverse.
    expect(res.status).toBe(404);
  }
});

test("the licence is not readable without a session", async () => {
  // It names the licence and the modules bought: not something to hand to
  // the internet, unlike /healthz which only says free or pro.
  process.env.SENTRELLO_LICENSE_PUBLIC_KEY_PATH = "secrets/license_public.pem";
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;
  const res = await server.fetch(new Request("http://localhost/api/license"));
  expect(res.status).toBe(401);
});

test("a business route is 401 without a session", async () => {
  process.env.SENTRELLO_LICENSE_PUBLIC_KEY_PATH = "secrets/license_public.pem";
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;
  const res = await server.fetch(new Request("http://localhost/api/contacts"));
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
});

/**
 * Owning a module and using it are different things.
 *
 * A business that buys Pro with four modules on a Friday should not find four
 * half-configured screens in its sidebar on Monday. The licence decides what
 * may run; this decides what has been set up, and until somebody says so the
 * answer is "not yet" rather than "no".
 */
test("an optional module stays out of the nav until it is turned on", async () => {
  const boughtScheduling = (need: { tier?: "pro"; module?: string }) =>
    need.module === "scheduling";

  const { nav, tiers } = loadModules(
    new Hono<SentrelloEnv>(),
    boughtScheduling,
    [mod("crm", "free"), mod("scheduling", "module")],
  );

  // The loader still loads it — its routes and jobs are real, and the licence
  // is what decides that. Only the way in is withheld.
  expect(nav.map((n) => n.id)).toContain("scheduling");
  expect(tiers.get("scheduling")).toBe("module");
  expect(tiers.get("crm")).toBe("free");

  const states = new Map([
    ["scheduling", { moduleId: "scheduling", enabled: false, enabledAt: null }],
  ]);
  const shown = nav.filter((item) =>
    tiers.get(item.moduleId) === "module"
      ? isEnabled(states, item.moduleId)
      : true,
  );
  expect(shown.map((n) => n.id)).toEqual(["crm"]);

  // A Free module is the product, not a purchase: nothing can hide it.
  expect(isEnabled(new Map(), "crm")).toBe(false);
  expect(shown.some((n) => n.id === "crm")).toBe(true);
});

/**
 * A screen somebody cannot open should not be offered.
 *
 * Found by inviting a colleague as Staff and looking at their sidebar: it
 * listed Settings, Bookkeeping and Roles, all of which answered 403 when
 * clicked. Being refused after clicking tells somebody twice that they cannot
 * do their job — once by the error, and once by the menu that suggested
 * otherwise.
 */
test("nav entries declare what they need, and the roles agree", () => {
  const withPermission = defineModule({
    id: "books",
    tier: "free",
    register(ctx) {
      ctx.registerNav({
        id: "bookkeeping",
        label: "Bookkeeping",
        requires: { bookkeeping: ["read"] },
      });
      ctx.registerNav({ id: "contacts", label: "Contacts" });
    },
  });

  const { nav, navPermissions } = loadModules(
    new Hono<SentrelloEnv>(),
    freeGate,
    [withPermission],
  );

  // The requirement travels beside the entry, never inside the payload the
  // browser receives — it is not the browser's decision to make.
  expect(nav.every((n) => !("requires" in n))).toBe(true);
  expect(navPermissions.get("bookkeeping")).toEqual({ bookkeeping: ["read"] });
  expect(navPermissions.has("contacts")).toBe(false);

  // And the compiled roles answer it the way the routes do.
  expect(roles.admin.authorize({ bookkeeping: ["read"] }).success).toBe(true);
  expect(roles.accounting.authorize({ bookkeeping: ["read"] }).success).toBe(
    true,
  );
  expect(roles.staff.authorize({ bookkeeping: ["read"] }).success).toBe(false);
  expect(roles.staff.authorize({ settings: ["update"] }).success).toBe(false);
  expect(roles.staff.authorize({ crm: ["read"] }).success).toBe(true);
});
