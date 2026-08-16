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
  "@sentrello/mod-time-tracking",
  "@sentrello/mod-scheduling",
  "@sentrello/mod-shop",
  // sentrello.com only, and additionally gated by SENTRELLO_CONTROL_PLANE=true
  "@sentrello/control-plane",
  // bmp.sentrello.com only: Sentrello's own console, gated again by
  // SENTRELLO_MASTER=true. It is never built into any customer bundle, so on
  // every other host this name simply does not resolve.
  "@sentrello/master",
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

/**
 * Bundles unpacked by the installer, discovered by path.
 *
 * Resolution by package name would mean writing links into the image's
 * node_modules, which the container cannot do when it runs as the customer's
 * own uid. The bundles directory is theirs and always writable, so the host
 * reads from there instead.
 */
/**
 * Bundles that were installed but would not load.
 *
 * A bundle that throws on import takes every one of its features with it —
 * a customer paying for Pro loses deals, reports, bank import and recurring
 * invoices at once. That used to be a warning in a log nobody reads, which is
 * how a broken import survived several releases. It is now reported by
 * /healthz and on the settings screen.
 */
export const failedBundles: { name: string; reason: string }[] = [];

async function discoverFromBundlesDir(dir: string): Promise<SentrelloModule[]> {
  const found: SentrelloModule[] = [];
  let entries: string[];
  try {
    const { readdir } = await import("node:fs/promises");
    entries = await readdir(dir);
  } catch {
    return found; // no bundles directory: a Free instance
  }

  for (const name of entries) {
    if (name.startsWith(".")) continue;
    try {
      const mod: unknown = await import(`${dir}/${name}/src/index.ts`);
      const candidate = (mod as { default?: unknown }).default;
      if (isModule(candidate)) found.push(candidate);
      else {
        const reason = "it has no valid default export";
        failedBundles.push({ name, reason });
        console.error(`[modules] bundle ${name} did not load: ${reason}`);
      }
    } catch (err) {
      const reason = (err as Error).message;
      failedBundles.push({ name, reason });
      console.error(`[modules] bundle ${name} did not load: ${reason}`);
    }
  }
  return found;
}

/** Resolves whichever optional bundles are installed; missing ones are normal. */
export async function discoverOptionalModules(
  packages: string[] = OPTIONAL_MODULE_PACKAGES,
  bundlesDir = process.env.SENTRELLO_BUNDLES_DIR,
): Promise<SentrelloModule[]> {
  const found: SentrelloModule[] = [];

  // development: bundles linked into node_modules by `bun link`
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

  // production: bundles the installer unpacked
  if (bundlesDir) {
    const seen = new Set(found.map((m) => m.id));
    for (const module of await discoverFromBundlesDir(bundlesDir)) {
      if (!seen.has(module.id)) found.push(module);
    }
  }

  return found;
}
