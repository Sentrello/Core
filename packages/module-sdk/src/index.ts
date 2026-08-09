import type { Hono } from "hono";

export type Tier = "free" | "pro" | "module";

/** What a running module can ask about the instance's entitlement. */
export interface EntitlementNeed {
  tier?: "pro";
  module?: string;
}

export interface ModuleContext {
  app: Hono;
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
