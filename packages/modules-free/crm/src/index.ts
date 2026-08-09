import { defineModule } from "@sentrello/module-sdk";

export default defineModule({
  id: "crm",
  tier: "free",
  register(ctx) {
    ctx.registerNav({ id: "crm", label: "Contacts", order: 10 });
    ctx.registerPermission("crm:read");
    ctx.app.get("/api/contacts", (c) => c.json({ contacts: [] }));
  },
});
