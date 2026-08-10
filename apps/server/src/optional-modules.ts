import type { SentrelloModule } from "@sentrello/module-sdk";

/**
 * Commercial bundles this host will use *if they are present on disk*.
 *
 * They are deliberately NOT dependencies of this package: Core is public and
 * AGPL, and must never declare or vendor commercial code. In development they
 * appear via `bun link` from the sibling Pro/Modules repos; in distribution the
 * installer only unpacks the bundles a license entitles (Packet 03).
 *
 * Presence alone grants nothing — the loader still checks `entitled(...)`, so a
 * leaked bundle without a valid license token stays dark.
 */
export const OPTIONAL_MODULE_PACKAGES = [
  "@sentrello/pro-core",
  // sentrello.com only, and additionally gated by SENTRELLO_CONTROL_PLANE=true
  "@sentrello/control-plane",
  "@sentrello/mod-time-tracking",
  "@sentrello/mod-scheduling",
  "@sentrello/mod-hr",
  "@sentrello/mod-inventory",
  "@sentrello/mod-projects",
  "@sentrello/mod-documents",
];

function isModule(value: unknown): value is SentrelloModule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SentrelloModule).id === "string" &&
    typeof (value as SentrelloModule).register === "function"
  );
}

/** Resolves whichever optional bundles are installed; missing ones are normal. */
export async function discoverOptionalModules(
  packages: string[] = OPTIONAL_MODULE_PACKAGES,
): Promise<SentrelloModule[]> {
  const found: SentrelloModule[] = [];
  for (const name of packages) {
    try {
      const mod: unknown = await import(name);
      const candidate = (mod as { default?: unknown }).default;
      if (isModule(candidate)) found.push(candidate);
      else console.warn(`[modules] ${name} has no valid default export`);
    } catch {
      // not installed on this instance — the overwhelmingly common case
    }
  }
  return found;
}
