import crm from "@sentrello/module-crm";
import { Hono } from "hono";
import { resolveLicense } from "./license";
import { loadModules } from "./loader";

const app = new Hono();
const { state, gate } = await resolveLicense();

// register modules (Packet 02 imports pro/optional modules here too)
const { nav, loaded } = loadModules(app, gate, [crm]);

app.get("/healthz", (c) =>
  c.json({
    status: "ok",
    tier: state.claims?.tier ?? "free",
    license_valid: state.valid,
    modules_loaded: loaded,
  }),
);

app.get("/api/_meta", (c) => c.json({ nav, loaded }));

const port = Number(process.env.PORT ?? 3000);
console.log(
  `Sentrello listening on :${port} (tier=${state.claims?.tier ?? "free"})`,
);
export default { port, fetch: app.fetch };
