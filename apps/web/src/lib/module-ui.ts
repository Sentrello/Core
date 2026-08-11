/**
 * Loading screens that arrived with a module.
 *
 * A module cannot be compiled into this bundle: Pro and the optional modules
 * live in private repos, and their code must never reach the public one. So
 * each ships a prebuilt script, the host serves it at `/modules/<id>/ui.js`
 * while the module is loaded, and the browser fetches it at runtime.
 *
 * The script is built with React and the query client left out and read from
 * `window.__sentrello` instead. Bundling its own copy of React would give the
 * page two Reacts, and two Reacts means hooks throw — the failure is confusing
 * and total, so the shared runtime is not optional.
 */
import * as reactQuery from "@tanstack/react-query";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { api } from "./api";
import * as money from "./money";
import * as ui from "./ui";

type ScreenComponent = () => React.ReactElement | null;

interface SentrelloRuntime {
  react: typeof React;
  jsxRuntime: typeof jsxRuntime;
  reactQuery: typeof reactQuery;
  /** the same primitives Core's own screens use, so modules look native */
  ui: typeof ui;
  money: typeof money;
  api: typeof api;
  /** where a module registers its screen as it loads */
  screens: Record<string, ScreenComponent>;
}

declare global {
  interface Window {
    __sentrello?: SentrelloRuntime;
  }
}

/** Publishes the shared runtime. Must run before any module script loads. */
export function installRuntime(): SentrelloRuntime {
  if (window.__sentrello) return window.__sentrello;
  const runtime: SentrelloRuntime = {
    react: React,
    jsxRuntime,
    reactQuery,
    ui,
    money,
    api,
    screens: {},
  };
  window.__sentrello = runtime;
  return runtime;
}

const inFlight = new Map<string, Promise<ScreenComponent | null>>();

/**
 * Fetches a module's screen, once per page load.
 *
 * A module whose script is missing or broken resolves to null rather than
 * throwing: the rest of the application — invoicing, the ledger — must keep
 * working when one module's screen does not.
 */
export function loadModuleScreen(id: string): Promise<ScreenComponent | null> {
  const runtime = installRuntime();
  const already = runtime.screens[id];
  if (already) return Promise.resolve(already);

  const existing = inFlight.get(id);
  if (existing) return existing;

  const promise = new Promise<ScreenComponent | null>((resolve) => {
    const script = document.createElement("script");
    script.src = `/modules/${encodeURIComponent(id)}/ui.js`;
    script.async = true;
    script.onload = () => {
      const screen = window.__sentrello?.screens[id] ?? null;
      if (!screen) {
        console.warn(`[modules] ${id} loaded but registered no screen`);
      }
      resolve(screen);
    };
    script.onerror = () => {
      console.warn(`[modules] ${id} has no screens on this instance`);
      resolve(null);
    };
    document.head.append(script);
  });

  inFlight.set(id, promise);
  return promise;
}
