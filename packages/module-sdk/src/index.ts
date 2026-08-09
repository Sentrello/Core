import { Hono } from "hono";

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
  session: { activeOrganizationId?: string | null; userId: string };
  user: { id: string };
}

/** The Hono environment the host app and every module route share. */
export type SentrelloEnv = { Variables: { session: SentrelloSession } };

export interface ModuleContext {
  app: Hono<SentrelloEnv>;
  /** True if the instance's license satisfies `need`. */
  entitled: (need: EntitlementNeed) => boolean;
  registerNav: (item: { id: string; label: string; order?: number }) => void;
  registerPermission: (permission: string) => void;
  registerJob: (job: {
    name: string;
    cron?: string;
    handler: () => Promise<void>;
  }) => void;
}

/** Every Free, Pro, and optional module implements exactly this. */
export interface SentrelloModule {
  id: string;
  tier: Tier;
  /** ids of modules that must load first */
  requires?: string[];
  register(ctx: ModuleContext): void;
}

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
): Hono<SentrelloEnv> {
  module.register({
    app,
    entitled: () => true,
    registerNav: () => {},
    registerPermission: () => {},
    registerJob: () => {},
  });
  return app;
}
