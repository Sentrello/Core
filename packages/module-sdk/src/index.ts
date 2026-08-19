import { Hono, type MiddlewareHandler } from "hono";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

export type Tier = "free" | "pro" | "module";

/** What a running module can ask about the instance's entitlement. */
export interface EntitlementNeed {
  tier?: "pro";
  module?: string;
}

/**
 * The parts of a session every module relies on. Structural on purpose: the SDK
 * is the public contract and must not depend on the auth package (auth depends
 * on the SDK, never the reverse).
 */
export interface SentrelloSession {
  session: {
    /** The row id, so a screen can tell which session is the one in front of you. */
    id: string;
    activeOrganizationId?: string | null;
    userId: string;
  };
  user: { id: string; email?: string | null; name?: string | null };
}

/** The Hono environment the host app and every module route share. */
export type SentrelloEnv = { Variables: { session: SentrelloSession } };

/** The host's app type. Modules take this rather than importing `hono`. */
export type SentrelloApp = Hono<SentrelloEnv>;

/** Middleware bound to the host's environment, so modules need no `hono` dep. */
export function defineMiddleware(
  handler: MiddlewareHandler<SentrelloEnv>,
): MiddlewareHandler<SentrelloEnv> {
  return createMiddleware<SentrelloEnv>(handler);
}

export interface ModuleContext {
  app: Hono<SentrelloEnv>;
  /** True if the instance's license satisfies `need`. */
  entitled: (need: EntitlementNeed) => boolean;
  registerNav: (item: {
    id: string;
    label: string;
    order?: number;
    /**
     * Which section of the sidebar this belongs under.
     *
     * The nav was a flat list, which is a large part of why the application
     * reads as unrelated parts: fifteen equal items say nothing about a
     * contact leading to a quote leading to an invoice. A section says at
     * least that they belong to the same piece of work.
     *
     * Free text rather than a fixed set, so a module can name a section the
     * host has never heard of. Anything without one sits at the top level.
     */
    group?: string;
    /**
     * The permission this entry's screen needs.
     *
     * The routes behind it are guarded regardless; this decides whether
     * somebody is offered the door at all. A staff member who can see
     * Settings in the sidebar, clicks it, and is refused has been told twice
     * that they cannot do their job — once by the error, and once by the menu
     * that suggested otherwise.
     */
    requires?: Record<string, string[]>;
    /**
     * Who is offered this entry, when "everybody who can load the module" is
     * the wrong answer.
     *
     * The loader decides whether a module runs at all; this decides whether a
     * person is shown the way in. Most modules need neither — a business's own
     * staff all see Invoices. It exists for entries whose audience is narrower
     * than the instance: an allow-list held in the environment rather than in
     * any role a business can grant.
     *
     * Not a security boundary. The routes are still guarded; this only stops
     * offering somebody a door that will not open.
     */
    visibleTo?: (session: SentrelloSession) => boolean;
  }) => void;
  registerPermission: (permission: string) => void;
  /**
   * Background work. The name is namespaced with the module id by the host, so
   * `reminders` is safe even if another module wants the same word. Without a
   * `cron` the queue exists but only runs when something sends to it.
   */
  registerJob: (job: {
    name: string;
    cron?: string;
    handler: () => Promise<unknown>;
  }) => void;
}

/**
 * A module's own tables.
 *
 * Each module keeps its migrations to itself, tracked in its own table, so
 * installing or removing a module never disturbs another's history. The host
 * applies them at boot for modules the licence actually loads.
 */
export interface ModuleMigrations {
  /** absolute path to the drizzle output folder, usually `${import.meta.dir}/../drizzle` */
  dir: string;
  /** the module's own migrations table, e.g. `__drizzle_migrations_time_tracking` */
  table: string;
}

/** Every Free, Pro, and optional module implements exactly this. */
export interface SentrelloModule {
  id: string;
  tier: Tier;
  /** ids of modules that must load first */
  requires?: string[];
  migrations?: ModuleMigrations;
  /**
   * Absolute path to this module's prebuilt browser screens, if it has any.
   *
   * The module names the file itself — `${import.meta.dir}/../ui/index.js` —
   * because the same code runs from a linked checkout in development and from
   * an unpacked bundle in production, and only the module knows where its own
   * files are. The host serves it at `/modules/<id>/ui.js`, and only while the
   * module is loaded: a screen for a feature the licence does not grant is
   * never served, not merely hidden.
   *
   * The file is built, not source. Customers' servers have no build tools.
   */
  ui?: string;
  register(ctx: ModuleContext): void;
}

export * from "./public-endpoints";
export * from "./stripe-signature";

/**
 * The context a route handler receives.
 *
 * Exported because TypeScript stops inferring it once a module registers
 * enough routes, and a module cannot name the type itself without depending on
 * Hono directly — which the bundle contract does not allow, since the
 * container links only this small set of packages.
 */
export type RouteContext = Context<SentrelloEnv>;

export function defineModule(m: SentrelloModule): SentrelloModule {
  return m;
}

/**
 * A host-shaped Hono app. Modules use this instead of depending on `hono`
 * themselves — a second copy of the framework gives structurally identical but
 * nominally incompatible generics, exactly like a second copy of the ORM.
 * Mainly useful for testing a module in isolation.
 */
export function createModuleApp(): Hono<SentrelloEnv> {
  return new Hono<SentrelloEnv>();
}

/** Registers a module against a bare app, with entitlement forced on. */
export function registerForTest(
  module: SentrelloModule,
  app: Hono<SentrelloEnv> = createModuleApp(),
  /**
   * What the licence is pretending to allow.
   *
   * Entitled to everything by default, which is what a module's own tests
   * want. Overridable because a module that behaves differently on Free than
   * on Pro — the dashboard does — has no way to test the Free half otherwise,
   * and the Free half is the one every new instance sees.
   */
  entitled: (need: EntitlementNeed) => boolean = () => true,
): Hono<SentrelloEnv> {
  module.register({
    app,
    entitled,
    registerNav: () => {},
    registerPermission: () => {},
    registerJob: () => {},
  });
  return app;
}
