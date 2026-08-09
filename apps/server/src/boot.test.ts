import { expect, test } from "bun:test";
import { defineModule } from "@sentrello/module-sdk";
import { Hono } from "hono";
import { resolveLicense } from "./license";
import { loadModules } from "./loader";

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
  const app = new Hono();
  const { loaded, nav, permissions } = loadModules(app, freeGate, [
    mod("crm", "free"),
  ]);
  expect(loaded).toEqual(["crm"]);
  expect(nav).toEqual([{ id: "crm", label: "crm", order: 10 }]);
  expect(permissions).toEqual(["crm:read"]);
});

test("pro + entitled optional modules load only when the gate allows", () => {
  const modules = [
    mod("crm", "free"),
    mod("pro-core", "pro"),
    mod("hr", "module"),
    mod("inventory", "module"),
  ];

  const proLoaded = loadModules(new Hono(), proGate, modules).loaded;
  expect(proLoaded).toContain("pro-core");
  expect(proLoaded).toContain("hr");
  expect(proLoaded).not.toContain("inventory");

  const freeLoaded = loadModules(new Hono(), freeGate, modules).loaded;
  expect(freeLoaded).toEqual(["crm"]);
});

test("module with an unmet `requires` is skipped", () => {
  const { loaded } = loadModules(new Hono(), freeGate, [
    mod("reports", "free", ["pro-core"]),
    mod("crm", "free"),
  ]);
  expect(loaded).toEqual(["crm"]);
});

test("dependency order is respected regardless of array order", () => {
  const { loaded } = loadModules(new Hono(), freeGate, [
    mod("c", "free", ["b"]),
    mod("b", "free", ["a"]),
    mod("a", "free"),
  ]);
  expect(loaded).toEqual(["a", "b", "c"]);
});

test("a skipped module registers no routes", async () => {
  const app = new Hono();
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
    tier: "free",
    license_valid: false,
    modules_loaded: ["crm"],
  });
});
